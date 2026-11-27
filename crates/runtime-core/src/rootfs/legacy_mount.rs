//! Namespace operations for RAM-backed roots and checked images with legacy journals.

use super::*;

pub(super) fn sync() -> Result<(), Errno> {
    if !resizable_persistence_enabled() {
        return match PERSISTENT_ROOTFS.lock().as_mut() {
            Some(mount) => mount.journal.sync(),
            None => Ok(()),
        };
    }
    let mut cursor = 0;
    loop {
        let count = ROOTFS.with(|state| state.dirty_persistent_timestamps.range(cursor..).take(64).count());
        if count == 0 { break; }
        let (next, mutations, generations) = ROOTFS.with(|state| {
            let mut mutations = crate::persistent_overlay::MutationBatch::new_writeback(count)?;
            let mut generations = crate::io_buffer::IoBuffer::allocate(count, true, |values| {
                values.try_reserve_exact(count).map_err(|_| Errno::ENOMEM)
            })?;
            let mut next = cursor;
            for &index in state.dirty_persistent_timestamps.range(cursor..) {
                next = index.checked_add(1).ok_or(Errno::EIO)?;
                let inode = state.get(index).ok_or(Errno::EIO)?;
                if inode.content_gen == inode.synced_content_gen {
                    return Err(Errno::EIO);
                }
                let kind = match inode.kind {
                    InodeKind::PersistentRegular => 1,
                    InodeKind::BaseRegular { source: BaseSource::Image, .. } => 4,
                    _ => return Err(Errno::EIO),
                };
                mutations.push_with(PERSISTENT_REGULAR_RECORD_BYTES, || Ok(Mutation::Put {
                    key: OverlayKey::Inode(inode.ino),
                    value: encode_inode_record(kind, &[], PersistentInodeMetadata::from_inode(inode))?,
                }))?;
                generations.push((index, inode.content_gen));
                if mutations.len() == 64 {
                    break;
                }
            }
            Ok::<_, Errno>((next, mutations, generations))
        })?;
        PERSISTENT_ROOTFS.lock().as_mut().ok_or(Errno::EIO)?.journal.commit_writeback_metadata(mutations.as_slice())?;
        ROOTFS.with(|state| {
            for (index, generation) in generations {
                if let Some(inode) = state.get_mut(index) {
                    if inode.content_gen == generation {
                        inode.synced_content_gen = generation;
                        state.dirty_persistent_timestamps.remove(&index);
                    }
                }
            }
        });
        cursor = next;
    }
    PERSISTENT_ROOTFS.lock().as_mut().ok_or(Errno::EIO)?.journal.sync()
}

pub(super) fn mkdir(comps: &[&[u8]], mode: u32, uid: u32, gid: u32) -> Result<(), Errno> {
    if resizable_persistence_enabled() {
        let (parent, name, parent_ino, inode) = ROOTFS.with(|state| {
            let (parent, last, target) = state.resolve(comps)?;
            if target.is_some() {
                return Err(Errno::EEXIST);
            }
            state.require_image_inode_slot()?;
            let ino = state.next_ino;
            if ino == u64::MAX {
                return Err(Errno::ENOSPC);
            }
            let inode = Inode::new(InodeKind::Dir(DirectoryEntries::new()), mode & 0o7777, uid, gid, 2, ino);
            Ok::<_, Errno>((parent, last.ok_or(Errno::ENOENT)?.to_vec(), state.get(parent).ok_or(Errno::EIO)?.ino, inode))
        })?;
        let mut allocated = commit_persistent_namespace(&[
            Mutation::Put {
                key: OverlayKey::Inode(inode.ino),
                value: encode_persistent_inode(&inode)?,
            },
            Mutation::Put {
                key: OverlayKey::Dirent { parent: parent_ino, name: name.clone() },
                value: inode.ino.to_le_bytes().to_vec(),
            },
        ], &[(parent, NamespaceTimestamp::Modified)])?;
        return ROOTFS.with(|state| {
            state.bump_next_ino(inode.ino);
            let index = state.insert_prepared_inode(inode);
            allocated.insert_into(state, parent, &name, index)?;
            state.recompute_dir_nlink(parent);
            state.persistent_allocated_blocks = Some(allocated.allocated);
            Ok(())
        });
    }
    reject_fixed_persistence_mutation()?;
    ROOTFS.with(|state| {
        let (parent, last, target) = state.resolve(comps)?;
        if target.is_some() {
            return Err(Errno::EEXIST);
        }
        let last = last.ok_or(Errno::ENOENT)?;
        let ino = state.alloc_ino();
        let new_idx = state.insert_inode(Inode::new(
            InodeKind::Dir(DirectoryEntries::new()),
            mode & 0o7777,
            uid,
            gid,
            2,
            ino,
        ))?;
        state.link_unpublished_inode(parent, last, new_idx)?;
        // A new subdirectory bumps the parent's link count (its `..`).
        if let Some(parent_inode) = state.get_mut(parent) {
            parent_inode.nlink += 1;
        }
        Ok(())
    })
}

pub(super) fn rmdir(comps: &[&[u8]]) -> Result<(), Errno> {
    let mut allocated = if resizable_persistence_enabled() {
        let (parent, key) = ROOTFS.with(|state| {
            let (parent, last, target) = state.resolve(comps)?;
            let target = target.ok_or(Errno::ENOENT)?;
            match &state.get(target).ok_or(Errno::ENOENT)?.kind {
                InodeKind::Dir(entries) if entries.is_empty() => {}
                InodeKind::Dir(_) => return Err(Errno::ENOTEMPTY),
                _ => return Err(Errno::ENOTDIR),
            }
            Ok::<_, Errno>((parent, OverlayKey::Dirent {
                parent: state.get(parent).ok_or(Errno::EIO)?.ino,
                name: last.ok_or(Errno::ENOENT)?.to_vec(),
            }))
        })?;
        Some(commit_persistent_namespace(&[Mutation::Delete { key }], &[(parent, NamespaceTimestamp::Modified)])?)
    } else {
        reject_fixed_persistence_mutation()?;
        None
    };
    ROOTFS.with(|state| {
        let (parent, last, target) = state.resolve(comps)?;
        let target = target.ok_or(Errno::ENOENT)?;
        let last = last.ok_or(Errno::ENOENT)?;
        match &state.get(target).ok_or(Errno::ENOENT)?.kind {
            InodeKind::Dir(entries) => {
                if !entries.is_empty() {
                    return Err(Errno::ENOTEMPTY);
                }
            }
            _ => return Err(Errno::ENOTDIR),
        }
        if let Some(committed) = allocated.as_mut() { committed.remove_from(state, parent, last)?; }
        else if let Some(InodeKind::Dir(entries)) = state.get_mut(parent).map(|i| &mut i.kind) { entries.remove(last); }
        if let Some(parent_inode) = state.get_mut(parent) {
            parent_inode.nlink = parent_inode.nlink.saturating_sub(1);
        }
        if let Some(inode) = state.get_mut(target) {
            inode.nlink = 0;
        }
        state.maybe_free(target);
        state.persistent_allocated_blocks = allocated.as_ref().map(|committed| committed.allocated);
        Ok(())
    })
}

pub(super) fn unlink(comps: &[&[u8]]) -> Result<(), Errno> {
    let mut allocated = if resizable_persistence_enabled() {
        let (parent, target, key) = ROOTFS.with(|state| {
            let (parent, last, target) = state.resolve(comps)?;
            let target = target.ok_or(Errno::ENOENT)?;
            if state.get(target).ok_or(Errno::ENOENT)?.is_dir() {
                return Err(Errno::EISDIR);
            }
            Ok::<_, Errno>((parent, target, OverlayKey::Dirent {
                parent: state.get(parent).ok_or(Errno::EIO)?.ino,
                name: last.ok_or(Errno::ENOENT)?.to_vec(),
            }))
        })?;
        Some(commit_persistent_namespace(
            &[Mutation::Delete { key }],
            &[(parent, NamespaceTimestamp::Modified), (target, NamespaceTimestamp::Changed)],
        )?)
    } else {
        reject_fixed_persistence_mutation()?;
        None
    };
    ROOTFS.with(|state| {
        let (parent, last, target) = state.resolve(comps)?;
        let target = target.ok_or(Errno::ENOENT)?;
        let last = last.ok_or(Errno::ENOENT)?;
        if state.get(target).ok_or(Errno::ENOENT)?.is_dir() {
            return Err(Errno::EISDIR);
        }
        if let Some(committed) = allocated.as_mut() { committed.remove_from(state, parent, last)?; }
        else if let Some(InodeKind::Dir(entries)) = state.get_mut(parent).map(|i| &mut i.kind) { entries.remove(last); }
        if let Some(inode) = state.get_mut(target) {
            inode.nlink = inode.nlink.saturating_sub(1);
        }
        state.maybe_free(target);
        state.persistent_allocated_blocks = allocated.as_ref().map(|committed| committed.allocated);
        Ok(())
    })
}

pub(super) fn rename(old_comps: &[&[u8]], new_comps: &[&[u8]]) -> Result<Option<u64>, Errno> {
    let into_own_subtree = new_comps.len() > old_comps.len()
        && new_comps.starts_with(old_comps);
    let mut allocated = if resizable_persistence_enabled() {
        let mutations = ROOTFS.with(|state| {
            let (old_parent, old_name, old_target) = state.resolve(old_comps)?;
            let old_target = old_target.ok_or(Errno::ENOENT)?;
            if into_own_subtree && state.get(old_target).ok_or(Errno::ENOENT)?.is_dir() {
                return Err(Errno::EINVAL);
            }
            let (new_parent, new_name, new_existing) = state.resolve(new_comps)?;
            if new_existing == Some(old_target) {
                return Ok::<_, Errno>(None);
            }
            let old_is_dir = state.get(old_target).ok_or(Errno::ENOENT)?.is_dir();
            if let Some(existing) = new_existing {
                let new_inode = state.get(existing).ok_or(Errno::ENOENT)?;
                if old_is_dir && !new_inode.is_dir() {
                    return Err(Errno::ENOTDIR);
                }
                if !old_is_dir && new_inode.is_dir() {
                    return Err(Errno::EISDIR);
                }
                if let InodeKind::Dir(entries) = &new_inode.kind {
                    if !entries.is_empty() {
                        return Err(Errno::ENOTEMPTY);
                    }
                }
            }
            let inode_number = state.get(old_target).ok_or(Errno::EIO)?.ino;
            let old_parent_number = state.get(old_parent).ok_or(Errno::EIO)?.ino;
            let new_parent_number = state.get(new_parent).ok_or(Errno::EIO)?.ino;
            Ok(Some(([
                Mutation::Delete {
                    key: OverlayKey::Dirent {
                        parent: old_parent_number,
                        name: old_name.ok_or(Errno::ENOENT)?.to_vec(),
                    },
                },
                Mutation::Put {
                    key: OverlayKey::Dirent {
                        parent: new_parent_number,
                        name: new_name.ok_or(Errno::ENOENT)?.to_vec(),
                    },
                    value: inode_number.to_le_bytes().to_vec(),
                },
            ], old_parent, new_parent, old_target, new_existing)))
        })?;
        if let Some((mutations, old_parent, new_parent, source, replaced)) = mutations {
            let mut timestamps = vec![
                (old_parent, NamespaceTimestamp::Modified),
                (new_parent, NamespaceTimestamp::Modified),
                (source, NamespaceTimestamp::Changed),
            ];
            if let Some(replaced) = replaced {
                timestamps.push((replaced, NamespaceTimestamp::Changed));
            }
            Some(commit_persistent_namespace(
                &mutations,
                &timestamps,
            )?)
        } else {
            None
        }
    } else {
        reject_fixed_persistence_mutation()?;
        None
    };
    ROOTFS.with(|state| {
        let (old_parent, old_name, old_target) = state.resolve(old_comps)?;
        let old_target = old_target.ok_or(Errno::ENOENT)?;
        if into_own_subtree && state.get(old_target).ok_or(Errno::ENOENT)?.is_dir() {
            return Err(Errno::EINVAL);
        }
        let old_name = old_name.ok_or(Errno::ENOENT)?.to_vec();
        let (new_parent, new_name, new_existing) = state.resolve(new_comps)?;
        let new_name = new_name.ok_or(Errno::ENOENT)?.to_vec();

        // Renaming a name to itself (same inode) is a no-op.
        if new_existing == Some(old_target) {
            return Ok(None);
        }

        let source = state.get(old_target).ok_or(Errno::ENOENT)?;
        let ino = source.ino;
        let old_is_dir = source.is_dir();

        if let Some(existing) = new_existing {
            let new_is_dir = state.get(existing).ok_or(Errno::ENOENT)?.is_dir();
            if old_is_dir && !new_is_dir {
                return Err(Errno::ENOTDIR);
            }
            if !old_is_dir && new_is_dir {
                return Err(Errno::EISDIR);
            }
            if new_is_dir {
                let empty = matches!(
                    &state.get(existing).ok_or(Errno::ENOENT)?.kind,
                    InodeKind::Dir(entries) if entries.is_empty()
                );
                if !empty {
                    return Err(Errno::ENOTEMPTY);
                }
            }
        }
        let prepared = match allocated.as_mut() {
            Some(committed) => committed.take_name(new_parent, &new_name)?,
            None => PreparedDirectoryName::new(&ROOTFS_METADATA, &new_name)?,
        };
        if let Some(existing) = new_existing {
            let new_is_dir = state.get(existing).ok_or(Errno::EIO)?.is_dir();
            // Detach and free the replaced destination.
            if let Some(committed) = allocated.as_mut() { committed.remove_from(state, new_parent, &new_name)?; }
            else if let Some(InodeKind::Dir(entries)) = state.get_mut(new_parent).map(|i| &mut i.kind) { entries.remove(&new_name); }
            if let Some(inode) = state.get_mut(existing) {
                inode.nlink = if new_is_dir {
                    0
                } else {
                    inode.nlink.saturating_sub(1)
                };
            }
            state.maybe_free(existing);
        }

        // Detach the source name and reattach under the destination name.
        if let Some(committed) = allocated.as_mut() { committed.remove_from(state, old_parent, &old_name)?; }
        else if let Some(InodeKind::Dir(entries)) = state.get_mut(old_parent).map(|i| &mut i.kind) { entries.remove(&old_name); }
        match state.get_mut(new_parent).map(|i| &mut i.kind) {
            Some(InodeKind::Dir(entries)) => {
                entries.insert_prepared(prepared, old_target);
            }
            _ => return Err(Errno::ENOTDIR),
        }

        state.recompute_dir_nlink(old_parent);
        if new_parent != old_parent {
            state.recompute_dir_nlink(new_parent);
        }
        state.persistent_allocated_blocks = allocated.as_ref().map(|committed| committed.allocated);
        Ok(Some(ino))
    })
}

pub(super) fn link(old_comps: &[&[u8]], new_comps: &[&[u8]]) -> Result<(), Errno> {
    let persistent = resizable_persistence_enabled();
    let mut allocated = if persistent {
        let (source, new_parent, mutation) = ROOTFS.with(|state| {
            let old_idx = {
                let root = state.mount_root()?;
                state.walk(root, old_comps)?
            };
            let source = state.get(old_idx).ok_or(Errno::ENOENT)?;
            if source.is_dir() {
                return Err(Errno::EPERM);
            }
            if source.nlink == u32::MAX {
                return Err(Errno::EMLINK);
            }
            let inode_number = source.ino;
            let (new_parent, new_name, new_existing) = state.resolve(new_comps)?;
            if new_existing.is_some() {
                return Err(Errno::EEXIST);
            }
            Ok::<_, Errno>((old_idx, new_parent, Mutation::Put {
                key: OverlayKey::Dirent {
                    parent: state.get(new_parent).ok_or(Errno::EIO)?.ino,
                    name: new_name.ok_or(Errno::ENOENT)?.to_vec(),
                },
                value: inode_number.to_le_bytes().to_vec(),
            }))
        })?;
        Some(commit_persistent_namespace(
            &[mutation],
            &[(new_parent, NamespaceTimestamp::Modified), (source, NamespaceTimestamp::Changed)],
        )?)
    } else {
        reject_fixed_persistence_mutation()?;
        None
    };
    ROOTFS.with(|state| {
        let old_idx = {
            let root = state.mount_root()?;
            state.walk(root, old_comps)?
        };
        let source = state.get(old_idx).ok_or(Errno::ENOENT)?;
        if source.is_dir() {
            return Err(Errno::EPERM); // no hard links to directories
        }
        if source.nlink == u32::MAX {
            return Err(Errno::EMLINK);
        }
        let (new_parent, new_name, new_existing) = state.resolve(new_comps)?;
        if new_existing.is_some() {
            return Err(Errno::EEXIST);
        }
        let new_name = new_name.ok_or(Errno::ENOENT)?.to_vec();
        let prepared = match allocated.as_mut() {
            Some(committed) => committed.take_name(new_parent, &new_name)?,
            None => PreparedDirectoryName::new(&ROOTFS_METADATA, &new_name)?,
        };
        match state.get_mut(new_parent).map(|i| &mut i.kind) {
            Some(InodeKind::Dir(entries)) => {
                entries.insert_prepared(prepared, old_idx);
            }
            _ => return Err(Errno::ENOTDIR),
        }
        if let Some(inode) = state.get_mut(old_idx) {
            inode.nlink += 1;
            if !persistent {
                inode.touch_changed();
            }
        }
        state.persistent_allocated_blocks = allocated.as_ref().map(|committed| committed.allocated);
        Ok(())
    })
}

pub(super) fn symlink(target: &[u8], comps: &[&[u8]], uid: u32, gid: u32) -> Result<(), Errno> {
    if resizable_persistence_enabled() {
        if target.len() > 4096 - PERSISTENT_REGULAR_RECORD_BYTES {
            return Err(Errno::ENAMETOOLONG);
        }
        let creation = ROOTFS.with(|state| {
            let (parent, last, existing) = state.resolve(comps)?;
            if existing.is_some() {
                return Err(Errno::EEXIST);
            }
            state.require_image_inode_slot()?;
            let ino = state.next_ino;
            if ino == u64::MAX {
                return Err(Errno::ENOSPC);
            }
            let inode = Inode::new(InodeKind::Symlink(own_metadata(target)?), 0o777, uid, gid, 1, ino);
            Ok::<_, Errno>((parent, last.ok_or(Errno::ENOENT)?.to_vec(), state.get(parent).ok_or(Errno::EIO)?.ino, inode))
        })?;
        let (parent, name, parent_ino, inode) = creation;
        let mut allocated = commit_persistent_namespace(&[
            Mutation::Put {
                key: OverlayKey::Inode(inode.ino),
                value: encode_persistent_inode(&inode)?,
            },
            Mutation::Put {
                key: OverlayKey::Dirent { parent: parent_ino, name: name.clone() },
                value: inode.ino.to_le_bytes().to_vec(),
            },
        ], &[(parent, NamespaceTimestamp::Modified)])?;
        return ROOTFS.with(|state| {
            state.bump_next_ino(inode.ino);
            let index = state.insert_prepared_inode(inode);
            allocated.insert_into(state, parent, &name, index)?;
            state.persistent_allocated_blocks = Some(allocated.allocated);
            Ok(())
        });
    }
    reject_fixed_persistence_mutation()?;
    ROOTFS.with(|state| {
        let (parent, last, existing) = state.resolve(comps)?;
        if existing.is_some() {
            return Err(Errno::EEXIST);
        }
        let last = last.ok_or(Errno::ENOENT)?;
        let ino = state.alloc_ino();
        let new_idx = state.insert_inode(Inode::new(
            InodeKind::Symlink(own_metadata(target)?),
            0o777,
            uid,
            gid,
            1,
            ino,
        ))?;
        state.link_unpublished_inode(parent, last, new_idx)?;
        Ok(())
    })
}

pub(super) fn update_metadata(
    target: MetadataTarget<'_>,
    update: impl FnOnce(&mut PersistentInodeMetadata) -> Result<(), Errno>,
) -> Result<(), Errno> {
    let persistent = resizable_persistence_enabled();
    if !persistent {
        reject_fixed_persistence_mutation()?;
    }
    let (index, missing) = match target {
        MetadataTarget::Path(path) => (walk_to_inode(path)?, Errno::ENOENT),
        MetadataTarget::Handle(handle) => (file_handle_to_inode(handle)?, Errno::EBADF),
    };
    if persistent {
        return update_persistent_inode_metadata(index, update);
    }
    ROOTFS.with(|state| {
        let inode = state.get_mut(index).ok_or(missing)?;
        let mut fields = PersistentInodeMetadata::from_inode(inode);
        update(&mut fields)?;
        fields.apply(inode);
        Ok(())
    })
}

pub(super) fn mknod_special(
    comps: &[&[u8]],
    mode: u32,
    uid: u32,
    gid: u32,
    type_bits: u32,
) -> Result<(), Errno> {
    if resizable_persistence_enabled() {
        let (parent, name, parent_ino, inode) = ROOTFS.with(|state| {
            let (parent, last, existing) = state.resolve(comps)?;
            if existing.is_some() {
                return Err(Errno::EEXIST);
            }
            state.require_image_inode_slot()?;
            let ino = state.next_ino;
            if ino == u64::MAX {
                return Err(Errno::ENOSPC);
            }
            let inode = Inode::new(InodeKind::Special(type_bits), mode & 0o7777, uid, gid, 1, ino);
            Ok::<_, Errno>((parent, last.ok_or(Errno::ENOENT)?.to_vec(), state.get(parent).ok_or(Errno::EIO)?.ino, inode))
        })?;
        let mut allocated = commit_persistent_namespace(&[
            Mutation::Put {
                key: OverlayKey::Inode(inode.ino),
                value: encode_persistent_inode(&inode)?,
            },
            Mutation::Put {
                key: OverlayKey::Dirent { parent: parent_ino, name: name.clone() },
                value: inode.ino.to_le_bytes().to_vec(),
            },
        ], &[(parent, NamespaceTimestamp::Modified)])?;
        return ROOTFS.with(|state| {
            state.bump_next_ino(inode.ino);
            let index = state.insert_prepared_inode(inode);
            allocated.insert_into(state, parent, &name, index)?;
            state.persistent_allocated_blocks = Some(allocated.allocated);
            Ok(())
        });
    }
    reject_fixed_persistence_mutation()?;
    ROOTFS.with(|state| {
        let (parent, last, existing) = state.resolve(comps)?;
        if existing.is_some() {
            return Err(Errno::EEXIST);
        }
        let last = last.ok_or(Errno::ENOENT)?;
        let ino = state.alloc_ino();
        let new_idx = state.insert_inode(Inode::new(
            InodeKind::Special(type_bits & S_IFMT),
            mode & 0o7777,
            uid,
            gid,
            1,
            ino,
        ))?;
        state.link_unpublished_inode(parent, last, new_idx)?;
        Ok(())
    })
}

pub(super) fn statfs() -> Result<WasmStatfs, Errno> {
    if fixed_persistence_enabled() {
        return persistent_statfs();
    }
    Ok(WasmStatfs {
        f_type: 0x858458f6, // RAMFS_MAGIC
        f_bsize: 4096,
        f_blocks: 262_144,
        f_bfree: 262_144,
        f_bavail: 262_144,
        f_files: 65_536,
        f_ffree: 65_536,
        f_fsid: 0,
        f_namelen: 255,
        f_frsize: 4096,
        f_flags: if is_nosuid() {
            wasm_posix_shared::statfs_flags::ST_NOSUID
        } else {
            0
        },
        _pad: 0,
    })
}

pub(super) fn open(path: &[u8], flags: u32, mode: u32, uid: u32, gid: u32) -> Result<i64, Errno> {
    if resizable_persistence_enabled() && flags & O_TRUNC != 0 && flags & O_ACCMODE != O_RDONLY {
        let handle = super::open_mutation(path, flags & !O_TRUNC, mode, uid, gid)?;
        if let Err(error) = truncate_handle_inner(handle, 0, |_, _| Err(Errno::EIO)) {
            release_handle(handle);
            return Err(error);
        }
        return Ok(handle);
    }
    let comps = split_components(path);
    if resizable_persistence_enabled() && flags & O_CREAT != 0 {
        let creation = ROOTFS.with(|state| {
            let (parent, last, target) = state.resolve(&comps)?;
            if target.is_some() {
                return Ok::<_, Errno>(None);
            }
            if flags & O_DIRECTORY != 0 {
                return Err(Errno::ENOTDIR);
            }
            let name = last.ok_or(Errno::ENOENT)?.to_vec();
            let parent_ino = state.get(parent).ok_or(Errno::EIO)?.ino;
            state.require_image_inode_slot()?;
            let ino = state.next_ino;
            if ino == u64::MAX {
                return Err(Errno::ENOSPC);
            }
            let mut inode = Inode::new(
                InodeKind::PersistentRegular,
                mode & 0o1777,
                uid,
                gid,
                1,
                ino,
            );
            inode.persistent_size = Some(0);
            Ok(Some((parent, name, parent_ino, inode)))
        })?;
        if let Some((parent, name, parent_ino, inode)) = creation {
            let mutations = [
                Mutation::Put {
                    key: OverlayKey::Inode(inode.ino),
                    value: encode_persistent_inode(&inode)?,
                },
                Mutation::Put {
                    key: OverlayKey::Dirent {
                        parent: parent_ino,
                        name: name.clone(),
                    },
                    value: inode.ino.to_le_bytes().to_vec(),
                },
            ];
            let mut allocated = commit_persistent_namespace(&mutations, &[(parent, NamespaceTimestamp::Modified)])?;
            return ROOTFS.with(|state| {
                state.bump_next_ino(inode.ino);
                let index = state.insert_prepared_inode(inode);
                allocated.insert_into(state, parent, &name, index)?;
                state.get_mut(index).ok_or(Errno::EIO)?.open_count = 1;
                state.persistent_allocated_blocks = Some(allocated.allocated);
                Ok(inode_to_file_handle(index))
            });
        }
    }
    let fixed_persistence = fixed_persistence_enabled();
    ROOTFS.with(|state| {
        let (parent, last, target) = state.resolve(&comps)?;
        let inode_idx = match target {
            Some(existing) => {
                if fixed_persistence && flags & O_TRUNC != 0 && flags & O_ACCMODE != O_RDONLY {
                    return Err(Errno::EROFS);
                }
                if flags & O_CREAT != 0 && flags & O_EXCL != 0 {
                    return Err(Errno::EEXIST);
                }
                let inode = state.get(existing).ok_or(Errno::ENOENT)?;
                if flags & O_TRUNC != 0 && flags & O_ACCMODE != O_RDONLY && inode.group_read_leases != 0 {
                    return Err(Errno::EOPNOTSUPP);
                }
                if matches!(inode.kind, InodeKind::Symlink(_)) {
                    // The caller resolves symlinks before open; a symlink reaching
                    // here means O_NOFOLLOW on the final component.
                    return Err(Errno::ELOOP);
                }
                if matches!(inode.kind, InodeKind::Special(_)) {
                    // A socket/FIFO node cannot be opened as a regular file; the
                    // fifo path is handled before rootfs::open is reached.
                    return Err(Errno::ENXIO);
                }
                if inode.is_dir() {
                    return Err(Errno::EISDIR);
                }
                if flags & O_DIRECTORY != 0 {
                    return Err(Errno::ENOTDIR);
                }
                if flags & O_TRUNC != 0 && flags & O_ACCMODE != O_RDONLY {
                    // A lazy-archive member truncates like anything else, and
                    // discarding its `(archive_id, source_path, size)` is the
                    // POINT rather than a loss: `O_TRUNC` means "this file is
                    // now empty", and what its bytes used to be backed by stops
                    // mattering the moment they stop existing.
                    //
                    // This used to be a deliberate `ENOSYS` guarding against
                    // "an empty writable file instead of the real content" --
                    // which is a description of truncation. It cost the derived
                    // image builders: replacing `/usr/bin/node` with eager
                    // bytes is a whole-file replace, and it failed `ENOSYS`.
                    //
                    // The case that genuinely needs the old bytes is a PARTIAL
                    // write, which does not set `O_TRUNC` and still reaches the
                    // materialization path that cannot serve them.
                    if let Some(node) = state.get_mut(existing) {
                        let shrank = match &node.kind {
                            InodeKind::Regular(d) => !d.is_empty(),
                            InodeKind::BaseRegular { size, .. } => *size > 0,
                            InodeKind::LazyMember { size, .. } => *size > 0,
                            _ => false,
                        };
                        node.kind = InodeKind::Regular(Vec::new());
                        if shrank {
                            node.clear_setid_on_modify();
                        }
                        node.touch_modified();
                    }
                }
                existing
            }
            None => {
                if fixed_persistence {
                    return Err(Errno::EROFS);
                }
                if flags & O_CREAT == 0 {
                    return Err(Errno::ENOENT);
                }
                if flags & O_DIRECTORY != 0 {
                    return Err(Errno::ENOTDIR);
                }
                let last = last.ok_or(Errno::ENOENT)?;
                let ino = state.alloc_ino();
                let new_idx = state.insert_inode(Inode::new(
                    InodeKind::Regular(Vec::new()),
                    mode & 0o7777,
                    uid,
                    gid,
                    1,
                    ino,
                ))?;
                state.link_unpublished_inode(parent, last, new_idx)?;
                new_idx
            }
        };
        // A directory opened without opendir is rejected so callers never treat a
        // dir handle as a file.
        if state.get(inode_idx).ok_or(Errno::ENOENT)?.is_dir() {
            return Err(Errno::EISDIR);
        }
        state.get_mut(inode_idx).ok_or(Errno::ENOENT)?.open_count += 1;
        Ok(inode_to_file_handle(inode_idx))
    })
}

pub(super) fn write<F>(idx: u32, offset: i64, buf: &[u8], mut byte_source: F) -> Result<usize, Errno>
where
    F: FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>,
{
    let buf = var_log_clamp_write(idx, offset as u64, buf)?;
    if fixed_persistence_enabled() {
        if declares_digest(idx) {
            return Err(Errno::EROFS);
        }
        let resizable = resizable_persistence_enabled();
        let (ino, image_ino, base_size) = ROOTFS.with(|state| {
            let inode = state.get(idx).ok_or(Errno::EBADF)?;
            match inode.kind {
                InodeKind::BaseRegular {
                    blob_id,
                    size,
                    source: BaseSource::Image,
                } if inode.mode & 0o6000 == 0 => Ok((inode.ino, Some(image_ino(blob_id)?), size)),
                InodeKind::PersistentRegular if resizable => Ok((inode.ino, None, 0)),
                _ => Err(Errno::EROFS),
            }
        })?;
        let buf = if resizable && !buf.is_empty() {
            let remaining = crate::kandelo_image_write::MAX_FILE_BYTES
                .checked_sub(offset as u64)
                .filter(|remaining| *remaining != 0)
                .ok_or(Errno::EFBIG)?;
            &buf[..core::cmp::min(buf.len() as u64, remaining) as usize]
        } else {
            buf
        };
        let end = (offset as u64)
            .checked_add(buf.len() as u64)
            .ok_or(Errno::EFBIG)?;
        if resizable && end > i64::MAX as u64 {
            return Err(Errno::EFBIG);
        }
        if !resizable && end > base_size {
            return Err(Errno::EFBIG);
        }
        if resizable && !buf.is_empty() {
            reserve_persistent_timestamp_slot(idx)?;
        }
        return write_persistent_file(idx, ino, image_ino, base_size, resizable,
            offset as u64, buf, &mut byte_source);
    }
    let start = usize::try_from(offset).map_err(|_| Errno::EFBIG)?;
    let end = start.checked_add(buf.len()).ok_or(Errno::EFBIG)?;
    ensure_materialized(idx, &mut byte_source)?;
    ROOTFS.with(|state| {
        let inode = state.get_mut(idx).ok_or(Errno::EBADF)?;
        {
            let InodeKind::Regular(data) = &mut inode.kind else {
                return Err(Errno::EISDIR);
            };
            if end > data.len() {
                grow_file_bytes(data, end, Errno::ENOSPC)?;
            }
            data[start..end].copy_from_slice(buf);
        }
        if !buf.is_empty() {
            inode.clear_setid_on_modify();
        }
        inode.touch_modified();
        Ok(buf.len())
    })
}

pub(super) fn truncate<F>(idx: u32, length: i64, mut byte_source: F) -> Result<(), Errno>
where
    F: FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>,
{
    if let Ok(new_size) = u64::try_from(length) {
        // Growing a file under `/var/log` spends the same cap a write does,
        // but a truncate has no short form: all of it fits or none of it.
        ROOTFS.with(|state| {
            if !state.var_log_governs(idx) {
                return Ok(());
            }
            let old_size = state.var_log_file_size(idx)?;
            match state.var_log_admit(idx, old_size, new_size, old_size)? {
                admitted if admitted < new_size => Err(Errno::ENOSPC),
                _ => Ok(()),
            }
        })?;
    }
    if fixed_persistence_enabled() {
        if !resizable_persistence_enabled() || declares_digest(idx) {
            return Err(Errno::EROFS);
        }
        let new_size = u64::try_from(length).map_err(|_| Errno::EINVAL)?;
        if new_size > crate::kandelo_image_write::MAX_FILE_BYTES {
            return Err(Errno::EFBIG);
        }
        let (ino, image_ino, base_size, old_size, base_tail_allocated) = ROOTFS.with(|state| {
            let inode = state.get(idx).ok_or(Errno::EBADF)?;
            match inode.kind {
                InodeKind::BaseRegular {
                    blob_id,
                    size,
                    source: BaseSource::Image,
                } if inode.mode & 0o6000 == 0 => Ok((
                    inode.ino,
                    Some(image_ino(blob_id)?),
                    size,
                    inode.persistent_size.unwrap_or(size),
                    inode.base_dense,
                )),
                InodeKind::PersistentRegular => Ok((
                    inode.ino,
                    None,
                    0,
                    inode.persistent_size.unwrap_or(0),
                    false,
                )),
                _ => Err(Errno::EROFS),
            }
        })?;
        let base_tail_allocated = if let Some(image_ino) = image_ino.filter(|_| {
            !base_tail_allocated && new_size < old_size && new_size < base_size && new_size % 4096 != 0
        }) {
            let geometry = ROOTFS.with(|state| state.image).ok_or(Errno::EIO)?;
            let block = new_size / 4096;
            with_image_file_allocations(geometry, image_ino, block..block + 1, &mut byte_source,
                |next_base| Ok(next_base()?.is_some()))?
        } else {
            base_tail_allocated
        };
        let allocated_blocks = if new_size >= old_size {
            ROOTFS.with(|state| state.get(idx).map(|inode| inode.allocated_blocks)).ok_or(Errno::EBADF)?
        } else {
            let mut active = PERSISTENT_ROOTFS.lock();
            let journal = &mut active.as_mut().ok_or(Errno::EIO)?.journal;
            ROOTFS.with(|state| composed_inode_block_count(journal,
                state.get(idx).ok_or(Errno::EBADF)?, state.image, base_size, new_size, &mut byte_source))?
        };
        reserve_persistent_timestamp_slot(idx)?;
        PERSISTENT_ROOTFS
            .lock()
            .as_mut()
            .ok_or(Errno::EIO)?
            .journal
            .truncate_file_at_with_base_tail(ino, base_size, new_size, base_tail_allocated, |at, dst| {
                match image_ino {
                    Some(image_ino) => read_image_bytes(image_ino, at, dst, &mut byte_source),
                    None => Err(Errno::EIO),
                }
            })?;
        ROOTFS.with(|state| {
            state.persistent_allocated_blocks = None;
            let inode = state.get_mut(idx).ok_or(Errno::EBADF)?;
            inode.persistent_size = Some(new_size);
            inode.allocated_blocks = allocated_blocks;
            if new_size != old_size {
                inode.clear_setid_on_modify();
            }
            inode.touch_modified();
            state.dirty_persistent_timestamps.insert(idx);
            Ok(())
        })?;
        return Ok(());
    }
    let new_len = usize::try_from(length).map_err(|_| Errno::EINVAL)?;
    if new_len == 0 {
        return ROOTFS.with(|state| {
            let inode = state.get_mut(idx).ok_or(Errno::EBADF)?;
            let shrank = match &inode.kind {
                InodeKind::Regular(d) => !d.is_empty(),
                InodeKind::BaseRegular { size, .. } => *size > 0,
                InodeKind::LazyMember { size, .. } => *size > 0,
                // Dir/Symlink/Special fall through to EISDIR.
                _ => return Err(Errno::EISDIR),
            };
            inode.kind = InodeKind::Regular(Vec::new());
            if shrank {
                inode.clear_setid_on_modify();
            }
            inode.touch_modified();
            Ok(())
        });
    }
    ensure_materialized(idx, &mut byte_source)?;
    ROOTFS.with(|state| {
        let inode = state.get_mut(idx).ok_or(Errno::EBADF)?;
        let changed = match &mut inode.kind {
            InodeKind::Regular(data) => {
                let old_len = data.len();
                // EFBIG, not ENOSPC: it is the error POSIX gives ftruncate()
                // for a length the file cannot take.
                grow_file_bytes(data, new_len, Errno::EFBIG)?;
                old_len != new_len
            }
            _ => return Err(Errno::EISDIR),
        };
        if changed {
            inode.clear_setid_on_modify();
        }
        inode.touch_modified();
        Ok(())
    })
}

pub(super) fn size(inode: &Inode) -> Result<i64, Errno> {
    match &inode.kind {
        InodeKind::BaseRegular { size, .. } => {
            i64::try_from(inode.persistent_size.unwrap_or(*size)).map_err(|_| Errno::EOVERFLOW)
        }
        InodeKind::Regular(data) => Ok(data.len() as i64),
        InodeKind::PersistentRegular => {
            i64::try_from(inode.persistent_size.unwrap_or(0)).map_err(|_| Errno::EOVERFLOW)
        }
        InodeKind::LazyMember { size, .. } => Ok(*size as i64),
        _ => Err(Errno::EISDIR),
    }
}

pub(super) fn pin_directory(state: &mut RootfsState, comps: &[&[u8]]) -> Result<u32, Errno> {
    let root = state.mount_root()?;
    let idx = state.walk(root, comps)?;
    match &state.get(idx).ok_or(Errno::ENOENT)?.kind {
        InodeKind::Dir(map) => {
            for &child_idx in map.values() {
                state.get(child_idx).ok_or(Errno::ENOENT)?;
            }
        }
        _ => return Err(Errno::ENOTDIR),
    }
    state.get_mut(idx).ok_or(Errno::ENOENT)?.open_count += 1;
    Ok(idx)
}

pub(super) fn read_directory_entry(
    inodes: &[Option<Inode>],
    directory: &Inode,
    iter: &mut DirIter,
    name_buf: &mut [u8],
) -> Result<Option<(u64, u32, usize)>, Errno> {
    let InodeKind::Dir(entries) = &directory.kind else {
        return Err(Errno::ENOTDIR);
    };
    let next = match iter.last_name.as_deref() {
        Some(last_name) => entries.next_after(last_name),
        None => entries.iter().next(),
    };
    let Some((name, &child_idx)) = next else {
        iter.exhausted = true;
        return Ok(None);
    };
    let n = name.len();
    if n > name_buf.len() {
        return Err(Errno::EINVAL);
    }
    let child = inodes
        .get(child_idx as usize)
        .and_then(|slot| slot.as_ref())
        .ok_or(Errno::ENOENT)?;
    name_buf[..n].copy_from_slice(name);
    let result = (child.ino, dirent_type(child) as u32, n);
    iter.last_name = Some(name.clone());
    Ok(Some(result))
}

impl RootfsState {
    /// Root ("/") inode index, created on first touch with default 0755 root:root
    /// metadata. The loader's `/` entry refines that metadata via
    /// [`super::insert_base_dir`].
    pub(super) fn mount_root(&mut self) -> Result<u32, Errno> {
        if self.kifs.is_some() {
            return Err(Errno::EOPNOTSUPP);
        }
        if let Some(root) = self.root {
            return Ok(root);
        }
        let ino = 1;
        let root = self.insert_inode(Inode::new(
            InodeKind::Dir(DirectoryEntries::new()),
            0o755,
            0,
            0,
            2,
            ino,
        ))?;
        self.bump_next_ino(ino);
        self.root = Some(root);
        Ok(root)
    }
}
