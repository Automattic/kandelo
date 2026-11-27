//! Format-independent operations on the namespace mounted at the root.

use alloc::vec::Vec;
use super::{
    ByteReq, Inode, InodeKind, MetadataTarget, PersistentInodeMetadata, ROOTFS, ROOTFS_DIR_SENTINEL,
    RootfsState, StatStamp, kifs_mount, legacy_mount, split_components,
};
use crate::ofd::OfdPath;
use wasm_posix_shared::mode::{S_IFDIR, S_IFLNK};
use wasm_posix_shared::{Errno, WasmStat, WasmStatfs};

pub(super) enum MountedFilesystem<'a> {
    Legacy(&'a mut RootfsState),
    Standalone(&'a mut kifs_mount::MountedKifs, &'a mut [Option<Inode>]),
}

impl RootfsState {
    pub(super) fn mounted_filesystem(&mut self) -> MountedFilesystem<'_> {
        if self.kifs.is_some() {
            MountedFilesystem::Standalone(self.kifs.as_mut().unwrap(), &mut self.inodes)
        } else {
            MountedFilesystem::Legacy(self)
        }
    }
}

impl MountedFilesystem<'_> {
    pub(super) fn format_version(&self) -> Option<u32> {
        match self {
            Self::Legacy(state) => state.image.map(|image| image.image.version),
            Self::Standalone(..) => Some(crate::kifs_v3::VERSION),
        }
    }

    pub(super) fn supports_stat_certification(&self) -> bool {
        matches!(self, Self::Standalone(..))
    }

    pub(super) fn stat_stamp(&self, route: u64, inode: u64) -> Option<StatStamp> {
        match self {
            Self::Legacy(_) => None,
            Self::Standalone(mount, _) => mount.namespace.stat_stamp(route, inode),
        }
    }

    pub(super) fn write_stat_lease_buckets(
        &self,
        inode: u64,
        expected: StatStamp,
        out: &mut [u8],
    ) -> Option<usize> {
        match self {
            Self::Legacy(_) => None,
            Self::Standalone(mount, _) => mount.namespace.write_stat_lease_buckets(inode, expected, out),
        }
    }

    pub(super) fn lstat(&mut self, path: &[u8]) -> Result<WasmStat, Errno> {
        match self {
            Self::Legacy(state) => {
                let root = state.mount_root()?;
                let index = state.walk(root, &split_components(path))?;
                Ok(state.get(index).ok_or(Errno::ENOENT)?.stat())
            }
            Self::Standalone(mount, _) => {
                let (number, record) = mount.namespace.lookup_path(path)?;
                Ok(kifs_mount::stat(number, record))
            }
        }
    }

    pub(super) fn readlink(&mut self, components: &[&[u8]], buf: &mut [u8]) -> Result<usize, Errno> {
        match self {
            Self::Legacy(state) => {
                let root = state.mount_root()?;
                let index = state.walk(root, components)?;
                let super::InodeKind::Symlink(target) = &state.get(index).ok_or(Errno::ENOENT)?.kind
                else {
                    return Err(Errno::EINVAL);
                };
                let n = target.len().min(buf.len());
                buf[..n].copy_from_slice(&target[..n]);
                Ok(n)
            }
            Self::Standalone(mount, _) => {
                let (number, _) = mount.lookup(components)?;
                mount.namespace.read_link(number, buf)
            }
        }
    }

    pub(super) fn symlink_target(
        &mut self,
        path: &[&[u8]],
    ) -> Result<Option<crate::IoBuffer<u8>>, Errno> {
        match self {
            Self::Legacy(state) => {
                let root = state.mount_root()?;
                let index = state.walk(root, path)?;
                match &state.get(index).ok_or(Errno::ENOENT)?.kind {
                    InodeKind::Symlink(target) => Ok(Some(crate::IoBuffer::copy_from(target)?)),
                    _ => Ok(None),
                }
            }
            Self::Standalone(mount, _) => mount.symlink_target(path),
        }
    }

    pub(super) fn fstat(&mut self, index: u32) -> Result<WasmStat, Errno> {
        match self {
            Self::Legacy(state) => Ok(state.get(index).ok_or(Errno::EBADF)?.stat()),
            Self::Standalone(mount, pins) => {
                let inode = pin(pins, index)?;
                Ok(kifs_mount::stat(inode.ino, mount.inode(inode.ino)?))
            }
        }
    }

    pub(super) fn size(&mut self, index: u32) -> Result<i64, Errno> {
        match self {
            Self::Legacy(state) => legacy_mount::size(state.get(index).ok_or(Errno::EBADF)?),
            Self::Standalone(mount, pins) => mount.size(pin(pins, index)?.ino),
        }
    }

    pub(super) fn read_positioned_file(
        &mut self,
        inode: u64,
        offset: u64,
        buf: &mut [u8],
    ) -> Result<usize, Errno> {
        match self {
            // Legacy journal reads compose checked base bytes with journal blocks.
            // Its caller already resolved that case before consulting the arena.
            Self::Legacy(_) => Err(Errno::EIO),
            Self::Standalone(mount, _) => mount.namespace.read_file(inode, offset, buf),
        }
    }

    pub(super) fn archive(&mut self, id: u32) -> Result<(u64, [u8; 32], Vec<u8>), Errno> {
        match self {
            Self::Legacy(state) => {
                let archive = state.archives.get(&id).ok_or(Errno::ENOENT)?;
                Ok((archive.size, archive.digest, archive.uri.to_vec()))
            }
            Self::Standalone(mount, _) => mount.archive(id),
        }
    }

    pub(super) fn directory_handle_path(&self, index: u32) -> Result<OfdPath, Errno> {
        match self {
            Self::Legacy(_) => Err(Errno::EBADF),
            Self::Standalone(mount, pins) => mount.directory_handle_path(pin(pins, index)?),
        }
    }

    pub(super) fn getdents_for_handle(
        &mut self,
        index: u32,
        buf: &mut [u8],
        offset: i64,
        root_entries: &[(&[u8], u8, u64)],
    ) -> Result<(usize, i64, bool), Errno> {
        match self {
            Self::Legacy(_) => Err(Errno::EBADF),
            Self::Standalone(mount, pins) => {
                mount.getdents_for_inode(pin(pins, index)?.ino, buf, offset, root_entries)
            }
        }
    }

    pub(super) fn getdents(
        &mut self,
        components: &[&[u8]],
        buf: &mut [u8],
        offset: i64,
        extra: &[(&[u8], u8, u64)],
    ) -> Result<(usize, i64, bool), Errno> {
        match self {
            Self::Legacy(state) => legacy_getdents(state, components, buf, offset, extra),
            Self::Standalone(mount, _) => {
                let (number, record) = mount.lookup(components)?;
                mount.getdents(number, record, buf, offset, extra)
            }
        }
    }
}

fn pin(pins: &[Option<Inode>], index: u32) -> Result<&Inode, Errno> {
    pins.get(index as usize).and_then(Option::as_ref).ok_or(Errno::EBADF)
}

// The legacy journal acquires the state lock during commit. Give its
// operations back their inputs after releasing the initial mount borrow.
fn dispatch_state<C, T>(
    context: C,
    standalone: impl FnOnce(&mut RootfsState, C) -> Result<T, Errno>,
    legacy: impl FnOnce(C) -> Result<T, Errno>,
) -> Result<T, Errno> {
    match ROOTFS.with(|state| match state.mounted_filesystem() {
        MountedFilesystem::Legacy(_) => Err(context),
        MountedFilesystem::Standalone(..) => Ok(standalone(state, context)),
    }) {
        Ok(result) => result,
        Err(context) => legacy(context),
    }
}

fn dispatch<C, T>(
    context: C,
    standalone: impl FnOnce(&mut kifs_mount::MountedKifs, &mut [Option<Inode>], C) -> Result<T, Errno>,
    legacy: impl FnOnce(C) -> Result<T, Errno>,
) -> Result<T, Errno> {
    dispatch_state(
        context,
        |state, context| standalone(state.kifs.as_mut().unwrap(), &mut state.inodes, context),
        legacy,
    )
}

pub(super) fn open(path: &[u8], flags: u32, mode: u32, uid: u32, gid: u32) -> Result<i64, Errno> {
    dispatch_state(
        (),
        |state, ()| kifs_mount::open_file(state, &split_components(path), flags, mode, uid, gid),
        |()| legacy_mount::open(path, flags, mode, uid, gid),
    )
}

pub(super) fn write<F>(index: u32, offset: i64, buf: &[u8], byte_source: F) -> Result<usize, Errno>
where
    F: FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>,
{
    dispatch(
        (),
        |mount, pins, ()| mount.write_file(pins, index, offset as u64, buf),
        |()| legacy_mount::write(index, offset, buf, byte_source),
    )
}

pub(super) fn truncate<F>(index: u32, length: i64, byte_source: F) -> Result<(), Errno>
where
    F: FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>,
{
    dispatch_state(
        (),
        |state, ()| state.truncate_kifs(index, length),
        |()| legacy_mount::truncate(index, length, byte_source),
    )
}

pub(super) fn has_positioned_namespace() -> bool {
    ROOTFS.with(|state| matches!(state.mounted_filesystem(), MountedFilesystem::Standalone(..)))
}

pub(super) fn release_inode(state: &mut RootfsState, index: u32) -> Result<(), Errno> {
    match state.mounted_filesystem() {
        MountedFilesystem::Legacy(state) => {
            state.maybe_free(index);
            Ok(())
        }
        MountedFilesystem::Standalone(..) => kifs_mount::release_unreferenced_inode(state, index),
    }
}

pub(super) fn open_directory_handle(path: &OfdPath) -> Result<i64, Errno> {
    ROOTFS.with(|state| match state.mounted_filesystem() {
        MountedFilesystem::Legacy(_) => Ok(ROOTFS_DIR_SENTINEL),
        MountedFilesystem::Standalone(..) => kifs_mount::open_directory_handle(state, path),
    })
}

pub(super) fn pin_directory(state: &mut RootfsState, components: &[&[u8]]) -> Result<u32, Errno> {
    match state.mounted_filesystem() {
        MountedFilesystem::Legacy(state) => legacy_mount::pin_directory(state, components),
        MountedFilesystem::Standalone(..) => kifs_mount::pin_directory(state, components),
    }
}

pub(super) fn read_directory_entry(
    state: &mut RootfsState,
    index: u32,
    name_buf: &mut [u8],
) -> Result<Option<(u64, u32, usize)>, Errno> {
    let iter = state.dir_iters.get_mut(index as usize).and_then(Option::as_mut).ok_or(Errno::EBADF)?;
    if iter.exhausted {
        return Ok(None);
    }
    let directory = pin(&state.inodes, iter.directory)?;
    match state.kifs.as_mut() {
        None => legacy_mount::read_directory_entry(&state.inodes, directory, iter, name_buf),
        Some(mount) => mount.read_directory_entry(directory, iter, name_buf),
    }
}

pub(super) fn mkdir(path: &[&[u8]], mode: u32, uid: u32, gid: u32) -> Result<(), Errno> {
    dispatch(
        (),
        |mount, _, ()| mount.create_named(path, S_IFDIR | (mode & 0o7777), uid, gid, None),
        |()| legacy_mount::mkdir(path, mode, uid, gid),
    )
}

pub(super) fn rmdir(path: &[&[u8]]) -> Result<(), Errno> {
    dispatch(
        path,
        |mount, pins, path| mount.remove_name(path, true, pins),
        legacy_mount::rmdir,
    )
}

pub(super) fn unlink(path: &[&[u8]]) -> Result<(), Errno> {
    dispatch(
        path,
        |mount, pins, path| mount.remove_name(path, false, pins),
        legacy_mount::unlink,
    )
}

pub(super) fn rename(
    old: &[u8],
    new: &[u8],
    old_components: &[&[u8]],
    new_components: &[&[u8]],
) -> Result<(), Errno> {
    dispatch(
        (),
        |mount, pins, ()| mount.rename(old, new, pins),
        |()| legacy_mount::rename(old_components, new_components),
    )
}

pub(super) fn link(old: &[&[u8]], new: &[&[u8]]) -> Result<(), Errno> {
    dispatch((), |mount, _, ()| mount.link(old, new), |()| legacy_mount::link(old, new))
}

pub(super) fn symlink(target: &[u8], path: &[&[u8]], uid: u32, gid: u32) -> Result<(), Errno> {
    dispatch(
        (),
        |mount, _, ()| mount.create_named(path, S_IFLNK | 0o777, uid, gid, Some(target)),
        |()| legacy_mount::symlink(target, path, uid, gid),
    )
}

pub(super) fn mknod_special(
    path: &[&[u8]],
    mode: u32,
    uid: u32,
    gid: u32,
    type_bits: u32,
) -> Result<(), Errno> {
    dispatch(
        (),
        |mount, _, ()| mount.create_named(path, type_bits | (mode & 0o7777), uid, gid, None),
        |()| legacy_mount::mknod_special(path, mode, uid, gid, type_bits),
    )
}

pub(super) fn update_metadata(
    target: MetadataTarget<'_>,
    update: impl FnOnce(&mut PersistentInodeMetadata) -> Result<(), Errno>,
) -> Result<(), Errno> {
    dispatch(
        (target, update),
        |mount, pins, (target, update)| mount.update_metadata(pins, target, update),
        |(target, update)| legacy_mount::update_metadata(target, update),
    )
}

pub(super) fn sync() -> Result<(), Errno> {
    dispatch((), |mount, _, ()| mount.namespace.sync(), |()| legacy_mount::sync())
}

pub(super) fn statfs() -> Result<WasmStatfs, Errno> {
    dispatch((), |mount, _, ()| Ok(mount.statfs()), |()| legacy_mount::statfs())
}

fn legacy_getdents(
    state: &mut RootfsState,
    comps: &[&[u8]],
    buf: &mut [u8],
    offset: i64,
    extra: &[(&[u8], u8, u64)],
) -> Result<(usize, i64, bool), Errno> {
    use super::{InodeKind, dirent_type};
    use super::DT_DIR;
    let root = state.mount_root()?;
    let idx = state.walk(root, comps)?;
    let dir = state.get(idx).ok_or(Errno::ENOENT)?;
    let InodeKind::Dir(map) = &dir.kind else {
        return Err(Errno::ENOTDIR);
    };
    for &child_idx in map.values() {
        state.get(child_idx).ok_or(Errno::ENOENT)?;
    }
    if offset < 0 {
        return Err(Errno::EINVAL);
    }
    let injected = extra.iter().enumerate().filter(|(index, (name, _, _))| {
        !map.contains_key(*name)
            && !extra[..*index]
                .iter()
                .any(|(earlier, _, _)| earlier == name)
    });
    let mut written = 0;
    let mut cookie = offset;
    while cookie < 2 {
        let name = if cookie == 0 {
            b".".as_slice()
        } else {
            b"..".as_slice()
        };
        let next_cookie = cookie + 1;
        let bytes =
            crate::procfs::write_dirent64(buf, written, dir.ino, next_cookie, DT_DIR as u8, name);
        if bytes == 0 {
            return if written == 0 {
                Err(Errno::EINVAL)
            } else {
                Ok((written, cookie, false))
            };
        }
        written += bytes;
        cookie = next_cookie;
    }

    // Reserve fixed prefix cookies for synthetic mount points. They must
    // not move when real names are inserted/deleted. Keep ordinary small
    // cookies usable by 32-bit seekdir/telldir, rather than tagging high bits.
    let real_base = i64::try_from(extra.len()).map_err(|_| Errno::EOVERFLOW)?
        .checked_add(2).ok_or(Errno::EOVERFLOW)?;
    for (index, &(name, d_type, ino)) in injected {
        let position = i64::try_from(index).map_err(|_| Errno::EOVERFLOW)?
            .checked_add(2).ok_or(Errno::EOVERFLOW)?;
        if position < cookie { continue; }
        let next_cookie = position.checked_add(1).ok_or(Errno::EOVERFLOW)?;
        let bytes = crate::procfs::write_dirent64(buf, written, ino, next_cookie, d_type, name);
        if bytes == 0 {
            return if written == 0 { Err(Errno::EINVAL) } else { Ok((written, position, false)) };
        }
        written += bytes;
        cookie = next_cookie;
    }
    let mut first = u64::try_from(cookie.saturating_sub(real_base).max(0)).map_err(|_| Errno::EINVAL)?;
    while let Some((entry_cookie, name, child_idx)) = map.next_from_cookie(first) {
        let position = i64::try_from(entry_cookie).map_err(|_| Errno::EOVERFLOW)?
            .checked_add(real_base).ok_or(Errno::EOVERFLOW)?;
        let next_cookie = position.checked_add(1).ok_or(Errno::EOVERFLOW)?;
        let child = state.get(child_idx).ok_or(Errno::ENOENT)?;
        let bytes = crate::procfs::write_dirent64(buf, written, child.ino, next_cookie, dirent_type(child), name);
        if bytes == 0 {
            return if written == 0 { Err(Errno::EINVAL) } else { Ok((written, position, false)) };
        }
        written += bytes;
        cookie = next_cookie;
        first = entry_cookie + 1;
    }
    Ok((written, cookie, true))
}
