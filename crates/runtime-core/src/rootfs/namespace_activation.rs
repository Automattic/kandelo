use super::*;
use crate::persistent_overlay::{transaction_encoded_length, MutationBatch};

pub(super) struct LeafReplacement<'a> {
    pub parent: u64,
    pub name: &'a [u8],
    pub expected: Option<u64>,
    pub replacement: Option<u64>,
}

pub(super) fn commit(
    state: &mut RootfsState,
    mount: &mut PersistentMount,
    edits: &[LeafReplacement<'_>],
) -> Result<(), Errno> {
    if !mount.resizable {
        return Err(Errno::EOPNOTSUPP);
    }
    if let Some(error) = mount.journal.recorded_error() {
        return Err(error);
    }
    if state
        .inodes
        .iter()
        .flatten()
        .any(|inode| inode.open_count != 0 || inode.map_pins != 0)
        || !state.dirty_persistent_timestamps.is_empty()
        || mount.journal.has_pending_writeback()
    {
        return Err(Errno::EBUSY);
    }
    if edits.is_empty() {
        return Ok(());
    }
    let mut scratch = ROOTFS_METADATA.reserve_temporary(0)?;
    let mut indices = reserve_replay_vec(state.inodes.iter().flatten().count(), &mut scratch)?;
    for (index, inode) in state.inodes.iter().enumerate() {
        if let Some(inode) = inode {
            indices.push((inode.ino, u32::try_from(index).map_err(|_| Errno::EIO)?));
        }
    }
    indices.sort_unstable_by_key(|entry| entry.0);
    if indices.windows(2).any(|pair| pair[0].0 == pair[1].0) {
        return Err(Errno::EIO);
    }
    let index_for = |ino| {
        indices
            .binary_search_by_key(&ino, |entry| entry.0)
            .map(|position| indices[position].1)
            .map_err(|_| Errno::ENOENT)
    };
    let maximum_timestamps = edits.len().checked_mul(3).ok_or(Errno::ENOMEM)?;
    let mut timestamps = reserve_replay_vec(maximum_timestamps, &mut scratch)?;
    let mut transaction = MutationBatch::new(
        edits
            .len()
            .checked_add(maximum_timestamps)
            .ok_or(Errno::ENOMEM)?,
    )?;
    let mut order = CanonicalDirentOrder::new();
    for edit in edits {
        order
            .accept(edit.parent, edit.name)
            .map_err(|_| Errno::EINVAL)?;
        if edit.expected == edit.replacement {
            return Err(Errno::EINVAL);
        }
        let parent = index_for(edit.parent)?;
        let InodeKind::Dir(entries) = &state.get(parent).ok_or(Errno::EIO)?.kind else {
            return Err(Errno::ENOTDIR);
        };
        let prior = entries
            .get(edit.name)
            .map(|index| state.get(*index).map(|inode| inode.ino).ok_or(Errno::EIO))
            .transpose()?;
        if prior != edit.expected {
            return Err(Errno::EEXIST);
        }
        timestamps.push((parent, NamespaceTimestamp::Modified));
        for ino in [edit.expected, edit.replacement].into_iter().flatten() {
            let index = index_for(ino)?;
            let inode = state.get(index).ok_or(Errno::EIO)?;
            if matches!(
                inode.kind,
                InodeKind::PersistentRegular
                    | InodeKind::BaseRegular { .. }
                    | InodeKind::LazyMember { .. }
            ) && inode.mode & 0o6000 != 0
            {
                return Err(Errno::EOPNOTSUPP);
            }
            if !matches!(
                inode.kind,
                InodeKind::PersistentRegular
                    | InodeKind::BaseRegular { .. }
                    | InodeKind::LazyMember { .. }
                    | InodeKind::Symlink(_)
            ) {
                return Err(Errno::EOPNOTSUPP);
            }
            timestamps.push((index, NamespaceTimestamp::Changed));
        }
        transaction.push_with(edit.name.len().checked_add(8).ok_or(Errno::ENOMEM)?, || {
            let mut name = Vec::new();
            name.try_reserve_exact(edit.name.len())
                .map_err(|_| Errno::ENOMEM)?;
            name.extend_from_slice(edit.name);
            let key = OverlayKey::Dirent {
                parent: edit.parent,
                name,
            };
            match edit.replacement {
                Some(ino) => {
                    let mut value = Vec::new();
                    value.try_reserve_exact(8).map_err(|_| Errno::ENOMEM)?;
                    value.extend_from_slice(&ino.to_le_bytes());
                    Ok(Mutation::Put { key, value })
                }
                None => Ok(Mutation::Delete { key }),
            }
        })?;
    }
    timestamps.sort_unstable_by_key(|(index, stamp)| {
        (*index, matches!(stamp, NamespaceTimestamp::Changed))
    });
    timestamps.dedup_by_key(|(index, _)| *index);
    let allocated = state.persistent_allocated_blocks.ok_or(Errno::EIO)?;
    let projected = persistent_namespace_blocks(state, transaction.as_slice(), &timestamps)?;
    let capacity = state.image.ok_or(Errno::EIO)?.capacity_bytes.div_ceil(4096);
    if projected > capacity && projected > allocated {
        return Err(Errno::ENOSPC);
    }
    let mut base_dirents = reserve_replay_vec(edits.len(), &mut scratch)?;
    for mutation in transaction.as_slice() {
        let key = match mutation {
            Mutation::Put { key, .. } | Mutation::Delete { key } => key,
        };
        if let OverlayKey::Dirent { parent, name } = key {
            let parent = index_for(*parent)?;
            let InodeKind::Dir(entries) = &state.get(parent).ok_or(Errno::EIO)?.kind else {
                return Err(Errno::ENOTDIR);
            };
            if entries.contains_key(name) && mount.journal.metadata_value(key)?.is_none() {
                if let Some(prepared) = mount.base_dirents.prepare_temporary(key)? {
                    base_dirents.push(prepared);
                }
            }
        }
    }
    let (sec, nsec) = now();
    let mut metadata = reserve_replay_vec(timestamps.len(), &mut scratch)?;
    for &(index, stamp) in &timestamps {
        let inode = state.get(index).ok_or(Errno::EIO)?;
        let target_bytes = match &inode.kind {
            InodeKind::Symlink(target) => target.len(),
            _ => 0,
        };
        let previous = scratch.bytes();
        scratch.resize(
            previous
                .checked_add(target_bytes.checked_mul(2).ok_or(Errno::ENOMEM)?)
                .ok_or(Errno::ENOMEM)?,
        )?;
        let mut change = PreparedPersistentMetadataChange::from_inode(index, inode)?;
        scratch.resize(
            previous
                .checked_add(
                    change
                        .target
                        .capacity()
                        .checked_mul(2)
                        .ok_or(Errno::ENOMEM)?,
                )
                .ok_or(Errno::ENOMEM)?,
        )?;
        if matches!(stamp, NamespaceTimestamp::Modified) {
            change.metadata.mtime_sec = sec;
            change.metadata.mtime_nsec = nsec;
        }
        change.metadata.ctime_sec = sec;
        change.metadata.ctime_nsec = nsec;
        transaction.push_with(
            PERSISTENT_REGULAR_RECORD_BYTES
                .checked_add(change.target.len())
                .ok_or(Errno::ENOMEM)?,
            || change.mutation(&mut mount.journal),
        )?;
        metadata.push(change);
    }
    transaction_encoded_length(transaction.as_slice())?;
    let replay = PreparedNamespaceReplay::load_from_dirents(state, &[], None, |visit| {
        for mutation in &transaction.as_slice()[..edits.len()] {
            match mutation {
                Mutation::Put {
                    key: OverlayKey::Dirent { parent, name },
                    value,
                } => visit(*parent, name, Some(value))?,
                Mutation::Delete {
                    key: OverlayKey::Dirent { parent, name },
                } => visit(*parent, name, None)?,
                _ => return Err(Errno::EIO),
            }
        }
        Ok(())
    })?;
    state.reserve_inode_slots(0)?;
    let mut additional = reserve_replay_vec(base_dirents.len(), &mut scratch)?;
    for prepared in &mut base_dirents {
        additional.push(prepared.reservation_mut());
    }
    let replay = replay.admit_with(state, &mut additional, || {
        mount.journal.commit(transaction.as_slice())
    })?;
    drop(additional);
    for prepared in base_dirents {
        mount.base_dirents.insert_prepared(prepared);
    }
    for change in metadata {
        let inode = state
            .get_mut(change.index)
            .expect("activation metadata inode missing");
        change.metadata.apply(inode);
        inode.synced_content_gen = inode.content_gen;
        state.dirty_persistent_timestamps.remove(&change.index);
    }
    replay.publish(state);
    state.persistent_allocated_blocks = Some(projected);
    Ok(())
}
