//! Exact graphics resources. Kept under syscalls so retained references use
//! the same last-close transaction as public close/dup2/exit, including locks.
use super::*;
use crate::owned_resource::{Kind, Resource, Target};
use wasm_posix_shared::dri_owned as W;

#[derive(Clone, Copy, Debug)]
pub(crate) struct BoBinding {
    pub offset: u32,
    pub kind: Kind,
}
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct OwnedDriOperands {
    pub source: Option<Target>,
    pub bindings: [Option<BoBinding>; 4],
}

pub(crate) fn owned_resource_validate(proc: &Process, target: Target) -> Result<(), Errno> {
    let ofd = proc.ofd_table.get(target.index).ok_or(Errno::EBADF)?;
    if ofd.ofd_id != target.id {
        return Err(Errno::EBADF);
    }
    if ofd.exec_close_quarantined {
        return Err(Errno::EBUSY);
    }
    Ok(())
}
fn validate_session(proc: &Process, target: Target) -> Result<(), Errno> {
    owned_resource_validate(proc, target)?;
    let gl = proc
        .ofd_table
        .get(target.index)
        .and_then(|o| o.dri())
        .and_then(|d| d.gl.as_ref());
    if gl.map(|g| g.session_id) != target.session
        || gl.is_some_and(|g| g.owner_pid != proc.pid as i32)
    {
        return Err(Errno::EACCES);
    }
    Ok(())
}
fn validate_actor(proc: &Process, target: Target) -> Result<(), Errno> {
    validate_session(proc, target)?;
    if proc
        .ofd_table
        .get(target.index)
        .and_then(|o| o.dri())
        .and_then(|d| d.gl.as_ref())
        .and_then(|g| g.context_id)
        != target.context
    {
        return Err(Errno::EACCES);
    }
    Ok(())
}
fn target_fd(proc: &Process, fd: i32) -> Result<Target, Errno> {
    let index = proc.fd_table.get(fd)?.ofd_ref.0;
    let ofd = proc.ofd_table.get(index).ok_or(Errno::EBADF)?;
    if ofd.is_path_only()
        || !matches!(
            ofd.dri_state.as_deref(),
            Some(
                crate::ofd::DriOfdState::RenderNode(_)
                    | crate::ofd::DriOfdState::Card { .. }
                    | crate::ofd::DriOfdState::PrimeBo(_)
                    | crate::ofd::DriOfdState::SyncFile(_)
                    | crate::ofd::DriOfdState::Syncobj(_)
            )
        )
    {
        return Err(Errno::EINVAL);
    }
    Ok(Target {
        index,
        id: ofd.ofd_id,
        original_fd: fd,
        session: ofd.dri().and_then(|d| d.gl.as_ref()).map(|g| g.session_id),
        context: ofd
            .dri()
            .and_then(|d| d.gl.as_ref())
            .and_then(|g| g.context_id),
    })
}
pub(crate) fn owned_resource_capture_file(
    proc: &mut Process,
    locks: &mut AdvisoryLockManager,
    host: &mut dyn HostIO,
    packet: &W::Packet,
) -> Result<(Target, Result<(), Errno>), Errno> {
    let opened = packet.action == W::OPEN;
    let fd = if opened {
        sys_open(
            proc,
            host,
            match packet.request {
                W::NODE_RENDER => b"/dev/dri/renderD128",
                W::NODE_CARD => b"/dev/dri/card0",
                _ => return Err(Errno::EINVAL),
            },
            O_RDWR | O_CLOEXEC,
            0,
        )?
    } else {
        packet.fd
    };
    let captured = (|| {
        let target = target_fd(proc, fd)?;
        if packet.flags & W::EXPECT_SYNC_FILE != 0
            && proc
                .ofd_table
                .get(target.index)
                .and_then(|o| o.sync_file())
                .is_none()
        {
            return Err(Errno::EINVAL);
        }
        proc.ofd_table.try_inc_ref_exact(target.index, target.id)?;
        Ok(target)
    })();
    match captured {
        Ok(target) => {
            let close = if opened || packet.flags & W::CONSUME_FD != 0 {
                sys_close_with_locks(proc, locks, host, fd)
            } else {
                Ok(())
            };
            // Once pinned, even a later close error leaves explicit custody.
            Ok((target, close))
        }
        Err(error) => {
            if opened {
                let _ = sys_close_implicit_with_locks(proc, locks, host, fd);
            }
            Err(error)
        }
    }
}
pub(crate) fn owned_resource_retain_kind(proc: &mut Process, kind: Kind) -> Result<(), Errno> {
    let target = kind.target();
    owned_resource_validate(proc, target)?;
    proc.ofd_table.try_inc_ref_exact(target.index, target.id)?;
    if let Kind::Bo { bo, .. } = kind {
        if crate::dri::with_registry(|r| r.incref(bo)).is_none() {
            // The caller's existing pin means undoing this increment cannot
            // be a last close and cannot bypass any backing cleanup.
            proc.ofd_table.dec_ref(target.index);
            return Err(Errno::ENOMEM);
        }
    }
    Ok(())
}
fn release_bo(host: &mut dyn HostIO, pid: i32, bo: u32) {
    if crate::dri::with_registry(|r| r.decref(bo)) == Some(0) {
        apply_dri_release_effect(pid, DriReleaseEffect::DestroyBo(bo), host);
    }
}
pub(crate) fn owned_resource_release_kind(
    proc: &mut Process,
    locks: &mut AdvisoryLockManager,
    host: &mut dyn HostIO,
    kind: Kind,
    explicit: bool,
) -> Result<(), Errno> {
    let target = kind.target();
    owned_resource_validate(proc, target)?;
    if let Kind::Bo { handle, bo, .. } = kind {
        if explicit && crate::owned_resource::retire_name_custody(kind, true) {
            let gem = dri_state(proc, target.index)?.gem.clone();
            let removed = {
                let mut names = gem.borrow_mut();
                if names.handles.get(&handle) == Some(&bo) {
                    names.handles.remove(&handle);
                    true
                } else {
                    false
                }
            };
            if removed {
                release_bo(host, proc.pid as i32, bo);
            }
        }
        release_bo(host, proc.pid as i32, bo);
    }
    release_ofd_reference_impl(proc, Some(locks), host, target.index)
}

/// Only documented handle fields accept a BO capability. Arbitrary offsets
/// must not turn a retained object into memory-write or namespace authority.
fn bo_field(request: u32, offset: u32) -> bool {
    use wasm_posix_shared::{dri::*, gl};
    match request {
        DRM_IOCTL_MODE_MAP_DUMB
        | DRM_IOCTL_PRIME_HANDLE_TO_FD
        | DRM_IOCTL_WPK_CHECK_BO_FORMAT
        | DRM_IOCTL_WPK_BIND_FOREIGN_TEXTURE
        | DRM_IOCTL_WPK_IMPORT_IMAGE => offset == 0,
        DRM_IOCTL_WPK_IMPORT_PLANAR_IMAGE => matches!(offset, 16 | 20 | 24),
        gl::GLIO_CREATE_SURFACE => offset == 16,
        gl::GLIO_UPDATE_SURFACE => matches!(offset, 16 | 20),
        DRM_IOCTL_MODE_ADDFB2 => matches!(offset, 20 | 24 | 28 | 32),
        DRM_IOCTL_MODE_ADDFB => offset == 24,
        _ => false,
    }
}
pub(crate) fn owned_resource_operands(
    proc: &Process,
    kind: Kind,
    packet: &W::Packet,
) -> Result<([Option<BoBinding>; 4], usize), Errno> {
    let contract =
        wasm_posix_shared::ioctl_contract::request_contract(packet.request).ok_or(Errno::ENOTTY)?;
    let size = contract
        .size_for_pointer_width(proc.pointer_width)
        .ok_or(Errno::EINVAL)? as usize;
    if size > W::BODY_BYTES {
        return Err(Errno::EINVAL);
    }
    let mut bindings = [None; 4];
    if packet.flags & W::BO_BINDINGS == 0 {
        if packet.length as usize != size {
            return Err(Errno::EINVAL);
        }
        return Ok((bindings, size));
    }
    let length = packet.length as usize;
    if length < size + 4 {
        return Err(Errno::EINVAL);
    }
    let count = u32::from_le_bytes(packet.body[size..size + 4].try_into().unwrap()) as usize;
    if count == 0 || count > 4 || length != size + 4 + 8 * count {
        return Err(Errno::EINVAL);
    }
    for slot in 0..count {
        let position = size + 4 + 8 * slot;
        let offset = u32::from_le_bytes(packet.body[position..position + 4].try_into().unwrap());
        let token = u32::from_le_bytes(packet.body[position + 4..position + 8].try_into().unwrap());
        if !bo_field(packet.request, offset)
            || offset as usize + 4 > size
            || bindings[..slot]
                .iter()
                .flatten()
                .any(|p: &BoBinding| p.offset == offset)
        {
            return Err(Errno::EINVAL);
        }
        let record = &proc.owned_resources.resources[proc.owned_resources.index(
            token,
            proc.pid,
            proc.exec_generation,
        )?];
        let bo_kind = record.kind.ok_or(Errno::EBADF)?;
        let Kind::Bo { file, handle, .. } = bo_kind else {
            return Err(Errno::EINVAL);
        };
        if file.id != kind.target().id
            || u32::from_le_bytes(
                packet.body[offset as usize..offset as usize + 4]
                    .try_into()
                    .unwrap(),
            ) != handle
        {
            return Err(Errno::EACCES);
        }
        bindings[slot] = Some(BoBinding {
            offset,
            kind: bo_kind,
        });
    }
    Ok((bindings, size))
}
pub(crate) fn owned_dri_bo(
    proc: &Process,
    index: usize,
    handle: u32,
    offset: u32,
    operands: Option<&OwnedDriOperands>,
) -> Result<u32, Errno> {
    if let Some(binding) =
        operands.and_then(|o| o.bindings.iter().flatten().find(|b| b.offset == offset))
    {
        if let Kind::Bo {
            file,
            handle: original,
            bo,
            ..
        } = binding.kind
        {
            owned_resource_validate(proc, file)?;
            if file.index != index || original != handle {
                return Err(Errno::EACCES);
            }
            return Ok(bo);
        }
        return Err(Errno::EINVAL);
    }
    dri_state(proc, index)?
        .gem
        .borrow()
        .handles
        .get(&handle)
        .copied()
        .ok_or(Errno::ENOENT)
}

fn fd_result_offset(request: u32) -> Option<usize> {
    use wasm_posix_shared::{dri::*, dri_sync::*};
    match request {
        DRM_IOCTL_PRIME_HANDLE_TO_FD
        | DRM_IOCTL_WPK_EXPORT_FENCE
        | DRM_IOCTL_SYNCOBJ_HANDLE_TO_FD => Some(8),
        DMA_BUF_IOCTL_EXPORT_SYNC_FILE => Some(4),
        _ => None,
    }
}
fn bo_result_offset(request: u32) -> Option<usize> {
    use wasm_posix_shared::dri::*;
    match request {
        DRM_IOCTL_MODE_CREATE_DUMB => Some(core::mem::offset_of!(WpkDrmModeCreateDumb, handle)),
        DRM_IOCTL_WPK_CREATE_GPU_BO => Some(8),
        DRM_IOCTL_PRIME_FD_TO_HANDLE => Some(0),
        DRM_IOCTL_WPK_EXPORT_IMAGE => Some(16),
        _ => None,
    }
}
pub(crate) fn owned_resource_dispatch(
    proc: &mut Process,
    locks: &mut AdvisoryLockManager,
    host: &mut dyn HostIO,
    kind: Kind,
    source: Option<Kind>,
    bindings: [Option<BoBinding>; 4],
    packet: &mut W::Packet,
    published: &mut Option<(i32, OfdId)>,
) -> Result<(), Errno> {
    let Kind::File(target) = kind else {
        return Err(Errno::EINVAL);
    };
    // GEM/PRIME/KMS authority follows the inherited DRM file, while its
    // renderer belongs to one image/session/context. Applying the renderer
    // guard to storage operations would break GBM on a fork-inherited file.
    let renderer = (wasm_posix_shared::gl::GLIO_INIT..=wasm_posix_shared::gl::GLIO_SUBMIT_QUERY)
        .contains(&packet.request)
        || matches!(
            packet.request,
            wasm_posix_shared::dri::DRM_IOCTL_WPK_BIND_FOREIGN_TEXTURE
                | wasm_posix_shared::dri::DRM_IOCTL_WPK_IMPORT_IMAGE
                | wasm_posix_shared::dri::DRM_IOCTL_WPK_IMPORT_PLANAR_IMAGE
                | wasm_posix_shared::dri::DRM_IOCTL_WPK_EXPORT_IMAGE
        );
    if renderer {
        validate_actor(proc, target)?;
    } else {
        owned_resource_validate(proc, target)?;
    }
    let canonical = wasm_posix_shared::ioctl_contract::request_contract(packet.request)
        .and_then(|c| c.size_for_pointer_width(proc.pointer_width))
        .ok_or(Errno::EINVAL)? as usize;
    let source_target = match source {
        Some(Kind::File(file)) => {
            owned_resource_validate(proc, file)?;
            let root = packet.request == wasm_posix_shared::gl::GLIO_INIT
                && u32::from_le_bytes(packet.body[4..8].try_into().unwrap())
                    == wasm_posix_shared::gl::SESSION_OBJECTS;
            if root
                || matches!(
                    packet.request,
                    wasm_posix_shared::gl::GLIO_QUERY | wasm_posix_shared::gl::GLIO_SUBMIT_QUERY
                )
            {
                validate_session(proc, file)?;
            }
            Some(file)
        }
        None => None,
        _ => return Err(Errno::EINVAL),
    };
    if packet.request == wasm_posix_shared::dri::DRM_IOCTL_PRIME_FD_TO_HANDLE
        && source_target.is_none()
    {
        return Err(Errno::EINVAL);
    }
    if packet.request == wasm_posix_shared::gl::GLIO_INIT {
        let role = u32::from_le_bytes(packet.body[4..8].try_into().unwrap());
        let fd = i32::from_le_bytes(packet.body[8..12].try_into().unwrap());
        if source_target.is_none() && (role == wasm_posix_shared::gl::SESSION_OBJECTS || fd != -1) {
            return Err(Errno::EINVAL);
        }
    }
    if matches!(
        packet.request,
        wasm_posix_shared::gl::GLIO_QUERY | wasm_posix_shared::gl::GLIO_SUBMIT_QUERY
    ) {
        let offset = if packet.request == wasm_posix_shared::gl::GLIO_QUERY {
            0
        } else if proc.pointer_width == 4 {
            core::mem::offset_of!(wasm_posix_shared::gl::GlSubmitQueryInfo, query)
        } else {
            core::mem::offset_of!(wasm_posix_shared::gl::GlSubmitQueryInfo64, query)
        };
        let op = u32::from_le_bytes(packet.body[offset..offset + 4].try_into().unwrap());
        if (op == wasm_posix_shared::gl::QOP_SERVER_WAIT) != source_target.is_some() {
            return Err(Errno::EINVAL);
        }
    }
    if source_target.is_some()
        && !matches!(
            packet.request,
            wasm_posix_shared::gl::GLIO_INIT
                | wasm_posix_shared::gl::GLIO_QUERY
                | wasm_posix_shared::gl::GLIO_SUBMIT_QUERY
                | wasm_posix_shared::dri::DRM_IOCTL_PRIME_FD_TO_HANDLE
        )
    {
        return Err(Errno::EINVAL);
    }
    let operands = OwnedDriOperands {
        source: source_target,
        bindings,
    };
    // Reserve child custody and every possible failure before the ioctl can
    // create storage or publish a descriptor. No allocation after effects.
    let capture_fd = packet.flags & W::CAPTURE_FD != 0;
    let capture_bo = packet.flags & W::CAPTURE_BO != 0;
    let fd_offset = if capture_fd {
        Some(fd_result_offset(packet.request).ok_or(Errno::EINVAL)?)
    } else {
        None
    };
    let bo_offset = if capture_bo {
        Some(bo_result_offset(packet.request).ok_or(Errno::EINVAL)?)
    } else {
        None
    };
    let token = if capture_fd || capture_bo {
        proc.owned_resources
            .resources
            .try_reserve(1)
            .map_err(|_| Errno::ENOMEM)?;
        Some(crate::owned_resource::next_token()?)
    } else {
        None
    };
    // Remember pre-existing names so a borrowed raw import is not silently
    // assigned ownership of somebody else's GEM_CLOSE obligation.
    let imported_bo =
        if capture_bo && packet.request == wasm_posix_shared::dri::DRM_IOCTL_PRIME_FD_TO_HANDLE {
            let idx = if let Some(source) = source_target {
                source.index
            } else {
                proc.fd_table
                    .get(i32::from_le_bytes(packet.body[8..12].try_into().unwrap()))?
                    .ofd_ref
                    .0
            };
            let prime = proc
                .ofd_table
                .get(idx)
                .and_then(|o| o.prime_bo())
                .ok_or(Errno::EINVAL)?;
            let gem = dri_state(proc, target.index)?.gem.borrow();
            Some((
                prime.bo_id,
                gem.handles.values().any(|&bo| bo == prime.bo_id),
            ))
        } else {
            None
        };
    // Reserve the independent file and known imported storage references
    // before effects. A fallible post-create retain would orphan custody
    // after a successfully published native/storage allocation.
    if capture_bo {
        crate::owned_resource::reserve_name_custody()?;
        proc.ofd_table.try_inc_ref_exact(target.index, target.id)?;
        if let Some((bo, _)) = imported_bo {
            if crate::dri::with_registry(|r| r.incref(bo)).is_none() {
                proc.ofd_table.dec_ref(target.index);
                return Err(Errno::EOVERFLOW);
            }
        }
    }
    let mut child_minted = false;
    let mut child_bo_hold = imported_bo.map(|(bo, _)| bo);
    let result = (|| {
        let state = proc
            .ofd_table
            .get(target.index)
            .ok_or(Errno::EBADF)?
            .dri_state
            .as_deref();
        match state {
            Some(crate::ofd::DriOfdState::SyncFile(file)) => {
                let file = file.clone();
                crate::dri::sync_file::ioctl(
                    proc,
                    host,
                    file,
                    packet.request,
                    &mut packet.body[..canonical],
                )?;
            }
            Some(crate::ofd::DriOfdState::PrimeBo(prime)) => {
                let bo = prime.bo_id;
                handle_dma_buf_sync_ioctl(
                    proc,
                    host,
                    bo,
                    packet.request,
                    &mut packet.body[..canonical],
                )?;
            }
            Some(crate::ofd::DriOfdState::Card { .. }) => {
                drm_ioctl_permit(proc, target.index, packet.request, false)?;
                crate::dri::ioctl_kms::handle_dri_card_ioctl_target(
                    proc,
                    host,
                    target.original_fd,
                    target.index,
                    packet.request,
                    &mut packet.body[..canonical],
                    Some(&operands),
                )?;
            }
            Some(crate::ofd::DriOfdState::RenderNode(_)) => {
                drm_ioctl_permit(proc, target.index, packet.request, true)?;
                handle_dri_ioctl_target(
                    proc,
                    host,
                    target.original_fd,
                    target.index,
                    packet.request,
                    &mut packet.body[..canonical],
                    Some(&operands),
                )?;
            }
            _ => return Err(Errno::EINVAL),
        }
        if let Some(offset) = fd_offset {
            let fd = i32::from_le_bytes(packet.body[offset..offset + 4].try_into().unwrap());
            let child = target_fd(proc, fd)?;
            proc.ofd_table.try_inc_ref_exact(child.index, child.id)?;
            proc.owned_resources.resources.push(Resource {
                token: token.unwrap(),
                pid: proc.pid,
                generation: proc.exec_generation,
                kind: Some(Kind::File(child)),
                last_transaction: 0,
                receipt: None,
                borrowed_alias: None,
            });
            packet.source_token = token.unwrap();
            packet.body[offset..offset + 4].copy_from_slice(&(-1i32).to_le_bytes());
            sys_close_with_locks(proc, locks, host, fd)?;
        } else if let Some(offset) = bo_offset {
            let handle = u32::from_le_bytes(packet.body[offset..offset + 4].try_into().unwrap());
            let bo = owned_dri_bo(proc, target.index, handle, offset as u32, None)?;
            if let Some((held, _)) = imported_bo {
                assert_eq!(held, bo, "PRIME import changed its admitted storage");
            } else {
                crate::dri::with_registry(|r| r.incref(bo)).ok_or(Errno::EOVERFLOW)?;
                child_bo_hold = Some(bo);
            }
            let child = Kind::Bo {
                file: target,
                handle,
                bo,
                owns_handle: !imported_bo.is_some_and(|(_, existing)| existing),
            };
            crate::owned_resource::capture_name_custody(child)?;
            proc.owned_resources.resources.push(Resource {
                token: token.unwrap(),
                pid: proc.pid,
                generation: proc.exec_generation,
                kind: Some(child),
                last_transaction: 0,
                receipt: None,
                borrowed_alias: None,
            });
            child_minted = true;
            packet.source_token = token.unwrap();
        } else if let Some(offset) = fd_result_offset(packet.request) {
            let fd = i32::from_le_bytes(packet.body[offset..offset + 4].try_into().unwrap());
            let index = proc.fd_table.get(fd)?.ofd_ref.0;
            *published = Some((fd, proc.ofd_table.get(index).ok_or(Errno::EBADF)?.ofd_id));
        }
        if matches!(
            packet.request,
            wasm_posix_shared::gl::GLIO_INIT
                | wasm_posix_shared::gl::GLIO_TERMINATE
                | wasm_posix_shared::gl::GLIO_CREATE_CONTEXT
                | wasm_posix_shared::gl::GLIO_DESTROY_CONTEXT
        ) {
            let gl = dri_state(proc, target.index)?.gl.as_ref();
            let session = gl.map(|g| g.session_id);
            let context = gl.and_then(|g| g.context_id);
            let owner = proc
                .owned_resources
                .index(packet.token, proc.pid, proc.exec_generation)?;
            if let Some(Kind::File(file)) = &mut proc.owned_resources.resources[owner].kind {
                file.session = session;
                file.context = context;
            }
        }
        Ok(())
    })();
    if capture_bo && !child_minted {
        if let Some(bo) = child_bo_hold {
            release_bo(host, proc.pid as i32, bo);
        }
        release_ofd_reference_impl(proc, Some(locks), host, target.index)?;
    }
    result
}
pub(crate) fn owned_resource_duplicate(
    proc: &mut Process,
    kind: Kind,
    packet: &mut W::Packet,
    published: &mut Option<(i32, OfdId)>,
) -> Result<(), Errno> {
    let Kind::File(target) = kind else {
        return Err(Errno::EINVAL);
    };
    owned_resource_validate(proc, target)?;
    let mut reuse_exact = packet.flags & W::REUSE_EXACT != 0;
    if packet.flags & W::BORROW_ALIAS != 0 {
        let owner = proc
            .owned_resources
            .index(packet.token, proc.pid, proc.exec_generation)?;
        if let Some((fd, id)) = proc.owned_resources.resources[owner].borrowed_alias {
            if proc
                .fd_table
                .get(fd)
                .ok()
                .and_then(|e| proc.ofd_table.get(e.ofd_ref.0))
                .is_some_and(|o| o.ofd_id == id)
            {
                packet.fd = fd;
                reuse_exact = true;
            }
        }
    }
    if reuse_exact
        && packet.fd >= 0
        && proc
            .fd_table
            .get(packet.fd)
            .ok()
            .and_then(|entry| proc.ofd_table.get(entry.ofd_ref.0))
            .is_some_and(|ofd| ofd.ofd_id == target.id)
    {
        let entry = proc.fd_table.get_mut(packet.fd)?;
        entry.fd_flags = if packet.flags & O_CLOEXEC != 0 {
            FD_CLOEXEC
        } else {
            0
        };
    } else {
        proc.ofd_table.try_inc_ref_exact(target.index, target.id)?;
        packet.fd = match proc.fd_table.alloc(
            OpenFileDescRef(target.index),
            if packet.flags & O_CLOEXEC != 0 {
                FD_CLOEXEC
            } else {
                0
            },
        ) {
            Ok(fd) => fd,
            Err(error) => {
                proc.ofd_table.dec_ref(target.index);
                return Err(error);
            }
        };
    }
    packet.result = packet.fd;
    *published = Some((packet.fd, target.id));
    if packet.flags & W::BORROW_ALIAS != 0 {
        let owner = proc
            .owned_resources
            .index(packet.token, proc.pid, proc.exec_generation)?;
        proc.owned_resources.resources[owner].borrowed_alias = *published;
    }
    Ok(())
}
pub(crate) enum OwnedMappingPlan {
    Bo {
        allocation: DeviceMapAllocation,
        hold: DriMappingHold,
        bo: u32,
        len: usize,
        identity: Option<crate::memory::ExactMappingIdentity>,
    },
    Commands {
        allocation: DeviceMapAllocation,
        target: Target,
        session: u32,
        display: OfdId,
        len: usize,
        identity: Option<crate::memory::ExactMappingIdentity>,
    },
}
impl OwnedMappingPlan {
    pub(crate) fn bo(
        proc: &mut Process,
        addr: usize,
        len: usize,
        prot: u32,
        flags: u32,
        bo: u32,
    ) -> Result<Self, Errno> {
        crate::dri::with_registry(|r| r.incref(bo)).ok_or(Errno::ENOMEM)?;
        let hold = DriMappingHold(Some(bo));
        let allocation = DeviceMapAllocation::prepare_with_binding_slots(
            proc, addr, len, prot, flags, 1,
        )?;
        Ok(Self::Bo {
            allocation,
            hold,
            bo,
            len,
            identity: None,
        })
    }
    fn with_identity(mut self, identity: Option<crate::memory::ExactMappingIdentity>) -> Self {
        match &mut self {
            Self::Bo { identity: slot, .. } | Self::Commands { identity: slot, .. } => *slot = identity,
        }
        self
    }
    pub(crate) fn identity(&self) -> Option<crate::memory::ExactMappingIdentity> {
        match self { Self::Bo { identity, .. } | Self::Commands { identity, .. } => *identity }
    }
    pub(crate) fn addr(&self) -> usize {
        match self {
            Self::Bo { allocation, .. } | Self::Commands { allocation, .. } => allocation.addr,
        }
    }
    pub(crate) fn rollback(self, proc: &mut Process) {
        match self {
            Self::Bo { allocation, .. } | Self::Commands { allocation, .. } => {
                allocation.rollback(proc)
            }
        }
    }
    pub(crate) fn commit(self, proc: &mut Process, host: &mut dyn HostIO) -> Result<usize, Errno> {
        match self {
            Self::Bo {
                allocation,
                mut hold,
                bo,
                len,
                identity,
            } => {
                let mapped = allocation.addr;
                // Bind admission is atomic. Rejection leaves old native views
                // intact, so even MAP_FIXED can restore its staged VMA table.
                if host.gbm_bo_bind(proc.pid as i32, bo, mapped, len, 0) < 0 {
                    allocation.rollback(proc);
                    return Err(Errno::ENOMEM);
                }
                allocation.commit(proc, host, true);
                if let Some(identity) = identity { proc.memory.publish_exact_mapping(mapped, identity); }
                proc.dri_bindings.push(crate::process::DriBoBinding {
                    addr: mapped,
                    len,
                    bo_id: bo,
                    bo_offset: 0,
                });
                hold.0 = None;
                Ok(mapped)
            }
            Self::Commands {
                allocation,
                target,
                session,
                display,
                len,
                identity,
            } => {
                if let Err(error) = validate_actor(proc, target) {
                    allocation.rollback(proc);
                    return Err(error);
                }
                let addr = allocation.addr;
                allocation.commit(proc, host, false);
                let dri = dri_state_mut(proc, target.index)?;
                let gl = dri.gl.as_mut().ok_or(Errno::EINVAL)?;
                gl.cmdbuf = Some(crate::ofd::CmdbufBinding {
                    addr,
                    len,
                    submit_seq: 0,
                });
                if let Some(owner) = dri.gl_resources.borrow_mut().owner.as_mut() {
                    owner.native_live = true;
                    owner.cmdbuf_range = Some((addr, len));
                }
                host.gl_bind(proc.pid as i32, addr, len, session, display.0);
                if let Some(identity) = identity { proc.memory.publish_exact_mapping(addr, identity); }
                Ok(addr)
            }
        }
    }
}
pub(crate) fn owned_resource_prepare_mmap(
    proc: &mut Process,
    kind: Kind,
    source: Option<Kind>,
    packet: &W::Packet,
) -> Result<OwnedMappingPlan, Errno> {
    if crate::owned_resource::has_pending_mapping(proc) {
        return Err(Errno::EBUSY);
    }
    let Kind::File(target) = kind else {
        return Err(Errno::EINVAL);
    };
    owned_resource_validate(proc, target)?;
    let word = |offset| u64::from_le_bytes(packet.body[offset..offset + 8].try_into().unwrap());
    let addr = usize::try_from(word(0)).map_err(|_| Errno::EOVERFLOW)?;
    let len = usize::try_from(word(8)).map_err(|_| Errno::EOVERFLOW)?;
    let offset = word(16) as i64;
    let prot = u32::from_le_bytes(packet.body[24..28].try_into().unwrap());
    let flags = u32::from_le_bytes(packet.body[28..32].try_into().unwrap());
    if flags & MAP_ANONYMOUS != 0 || offset < 0 || len == 0 {
        return Err(Errno::EINVAL);
    }
    let ofd = proc.ofd_table.get(target.index).ok_or(Errno::EBADF)?;
    let bo = if let Some(Kind::Bo { file, bo, .. }) = source {
        owned_resource_validate(proc, file)?;
        if file.id != target.id || (offset != 0 && offset as u64 != u64::from(bo) << 12) {
            return Err(Errno::EACCES);
        }
        bo
    } else if source.is_some() {
        return Err(Errno::EINVAL);
    } else if let Some(prime) = ofd.prime_bo() {
        if offset != 0 {
            return Err(Errno::EINVAL);
        }
        if flags & wasm_posix_shared::mmap::MAP_SHARED != 0
            && prot & wasm_posix_shared::mmap::PROT_WRITE != 0
            && ofd.status_flags() & O_ACCMODE != O_RDWR
        {
            return Err(Errno::EACCES);
        }
        prime.bo_id
    } else {
        let dri = dri_state(proc, target.index)?;
        if offset == 0 {
            validate_actor(proc, target)?;
            let gl = dri.gl.as_ref().ok_or(Errno::EINVAL)?;
            if gl.owner_pid != proc.pid as i32
                || !gl.initialized
                || gl.role != wasm_posix_shared::gl::SESSION_OBJECTS
                || gl.cmdbuf.is_some()
                || len != wasm_posix_shared::gl::CMDBUF_LEN
            {
                return Err(Errno::EINVAL);
            }
            let session = gl.session_id;
            let display = gl.display_file_id.ok_or(Errno::EINVAL)?;
            let identity = if packet.action == W::MMAP_EXACT {
                Some(crate::memory::ExactMappingIdentity {
                    id: proc.memory.reserve_exact_mapping_id()?, source_file: target.id.0, source_bo: None,
                })
            } else { None };
            let allocation = DeviceMapAllocation::prepare(proc, addr, len, prot, flags)?;
            return Ok(OwnedMappingPlan::Commands {
                allocation,
                target,
                session,
                display,
                len,
                identity,
            });
        }
        if offset as u64 & 0xfff != 0 || (offset as u64) >> 12 > u64::from(u32::MAX) {
            return Err(Errno::EINVAL);
        }
        let bo = ((offset as u64) >> 12) as u32;
        if bo == 0 || !dri_fd_has_bo_handle(dri, bo) {
            return Err(Errno::EACCES);
        }
        bo
    };
    let (size, tier) =
        crate::dri::with_registry(|r| r.get(bo).map(|b| (b.size, b.tier))).ok_or(Errno::EBADF)?;
    let rounded = size.checked_add(0xffff).ok_or(Errno::EINVAL)? & !0xffff;
    // Exact FILE/BO authority changes custody, not mmap range semantics.
    // Accept the same bounded prefix through owned and public entry points;
    // the staged constructor still preserves every replacement mapping.
    if tier == crate::dri::BoTier::GpuTexture || len as u64 > rounded {
        return Err(Errno::EINVAL);
    }
    let identity = if packet.action == W::MMAP_EXACT {
        Some(crate::memory::ExactMappingIdentity {
            id: proc.memory.reserve_exact_mapping_id()?, source_file: target.id.0, source_bo: Some(bo),
        })
    } else { None };
    Ok(OwnedMappingPlan::bo(proc, addr, len, prot, flags, bo)?.with_identity(identity))
}

pub(crate) fn owned_resource_unmap_exact(
    proc: &mut Process,
    host: &mut dyn HostIO,
    kind: Kind,
    source: Option<Kind>,
    packet: &W::Packet,
) -> Result<(), Errno> {
    let Kind::File(target) = kind else { return Err(Errno::EINVAL); };
    owned_resource_validate(proc, target)?;
    let source_bo = match source {
        None => None,
        Some(Kind::Bo { file, bo, .. }) => {
            owned_resource_validate(proc, file)?;
            if file.id != target.id { return Err(Errno::EACCES); }
            Some(bo)
        }
        Some(Kind::File(_)) => return Err(Errno::EINVAL),
    };
    let id = u64::from_le_bytes(packet.body[..8].try_into().unwrap());
    let ranges = proc.memory.exact_mapping_ranges(id, target.id.0, source_bo)?;
    if ranges.is_empty() { return Ok(()); }
    // One preflight covers every surviving fragment. Native retirement cannot
    // partially succeed and then discover missing split/vector capacity.
    DeviceUnmapPlan::prepare_exact(proc, ranges)?.commit(proc, host);
    proc.memory.retire_exact_mapping_regions(id);
    Ok(())
}
/// Before mapping refs retire, abort any unpublished constructor while its
/// old VMAs still retain the split-hold backing required by rollback.
pub(crate) fn rollback_owned_mapping_plans(proc: &mut Process) {
    for index in 0..proc.owned_resources.resources.len() {
        let plan = proc.owned_resources.resources[index]
            .receipt
            .as_mut()
            .and_then(|r| {
                r.awaiting_mapping_finish = false;
                r.mapping_plan.take()
            });
        if let Some(plan) = plan {
            plan.rollback(proc);
        }
    }
}

pub(crate) fn drain_owned_resources(
    proc: &mut Process,
    locks: &mut AdvisoryLockManager,
    host: &mut dyn HostIO,
) {
    rollback_owned_mapping_plans(proc);
    let state = core::mem::take(&mut proc.owned_resources);
    // Image destruction discards C bookkeeping, not the namespace inherited
    // by a fork child. Drop storage pins; ordinary last OFD close owns GEM
    // retirement. Running explicit BO_RELEASE destructors here breaks fork.
    for resource in state.resources {
        if let Some(receipt) = resource.receipt {
            if let Some(source) = receipt.source {
                let _ = owned_resource_release_kind(proc, locks, host, source, false);
            }
            for binding in receipt.bindings.into_iter().flatten() {
                let _ = owned_resource_release_kind(proc, locks, host, binding.kind, false);
            }
        }
        if let Some((fd, id)) = resource.borrowed_alias {
            if proc
                .fd_table
                .get(fd)
                .ok()
                .and_then(|e| proc.ofd_table.get(e.ofd_ref.0))
                .is_some_and(|o| o.ofd_id == id)
            {
                let _ = sys_close_implicit_with_locks(proc, locks, host, fd);
            }
        }
        if let Some(kind) = resource.kind {
            crate::owned_resource::retire_name_custody(kind, false);
            let _ = owned_resource_release_kind(proc, locks, host, kind, false);
        }
    }
}

/// Forced removal already consumes each whole OFD below this call. Only the
/// independent BO increments must be retired here; running last-close twice
/// or explicitly closing inherited GEM names would corrupt fork peers.
pub(crate) fn collect_owned_resource_removal_effects(proc: &mut Process) -> Vec<DriReleaseEffect> {
    let state = core::mem::take(&mut proc.owned_resources);
    let mut effects = Vec::new();
    let mut release = |kind: Kind| {
        if let Kind::Bo { bo, .. } = kind {
            if crate::dri::with_registry(|r| r.decref(bo)) == Some(0) {
                effects.push(DriReleaseEffect::DestroyBo(bo));
            }
        }
    };
    for resource in state.resources {
        if let Some(kind) = resource.kind {
            crate::owned_resource::retire_name_custody(kind, false);
            release(kind);
        }
        if let Some(receipt) = resource.receipt {
            if let Some(kind) = receipt.source {
                release(kind);
            }
            for binding in receipt.bindings.into_iter().flatten() {
                release(binding.kind);
            }
        }
    }
    effects
}

pub(crate) fn owned_resource_bo_info(
    proc: &Process,
    kind: Kind,
    packet: &mut W::Packet,
) -> Result<(), Errno> {
    let Kind::Bo { file, bo, .. } = kind else {
        return Err(Errno::EINVAL);
    };
    owned_resource_validate(proc, file)?;
    crate::dri::with_registry(|registry| {
        let bo = registry.get(bo).ok_or(Errno::EBADF)?;
        packet.body[..8].copy_from_slice(&bo.size.to_le_bytes());
        let tier = match bo.tier {
            crate::dri::BoTier::CpuShared => 0,
            crate::dri::BoTier::GpuTexture => 1,
        };
        for (offset, value) in [
            (8, bo.width),
            (12, bo.height),
            (16, bo.stride),
            (20, bo.format),
            (24, tier),
        ] {
            packet.body[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
        }
        Ok(())
    })
}

/// Same sync_file readiness object as public poll; the numeric alias is never
/// consulted. The receipt owns the original monotonic deadline across wakes.
pub(crate) fn owned_resource_poll(
    proc: &Process,
    host: &mut dyn HostIO,
    kind: Kind,
    deadline: Option<i64>,
    packet: &mut W::Packet,
) -> Result<(), Errno> {
    use wasm_posix_shared::poll::{POLLIN, POLLRDNORM};
    let Kind::File(target) = kind else {
        return Err(Errno::EINVAL);
    };
    owned_resource_validate(proc, target)?;
    let file = proc
        .ofd_table
        .get(target.index)
        .and_then(|o| o.sync_file())
        .ok_or(Errno::EINVAL)?;
    let events = u32::from_le_bytes(packet.body[..4].try_into().unwrap());
    let ready = events & u32::from((POLLIN | POLLRDNORM) as u16) != 0 && file.poll_readable();
    let timeout = i32::from_le_bytes(packet.body[8..12].try_into().unwrap());
    let expired = if let Some(end) = deadline {
        crate::dri::sync_file::monotonic_now(host)? >= end
    } else {
        false
    };
    if ready || timeout == 0 || expired {
        let revents = if ready {
            events & u32::from((POLLIN | POLLRDNORM) as u16)
        } else {
            0
        };
        packet.body[4..8].copy_from_slice(&revents.to_le_bytes());
        packet.body[12..16].fill(0);
        packet.result = i32::from(ready);
        return Ok(());
    }
    let tid = current_tid_for_process(proc);
    if proc.deliverable_for(tid) != 0 && !proc.should_restart_for(tid) {
        return Err(Errno::EINTR);
    }
    packet.body[12..16]
        .copy_from_slice(&crate::owned_resource::remaining_ms(host, deadline)?.to_le_bytes());
    Err(Errno::EAGAIN)
}
