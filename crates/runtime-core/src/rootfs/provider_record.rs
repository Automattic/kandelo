use super::*;
use crate::sdef::{DeferredArchive, DeferredRecord, DeferredSection};

pub(super) struct Decoded {
    section: DeferredSection,
    _reservation: MetadataReservation<'static>,
}

impl Decoded {
    fn record(&self) -> &DeferredRecord {
        &self.section.records[0]
    }
}

pub(super) fn identity(bytes: &[u8]) -> Result<(u64, [u8; 32]), Errno> {
    let decoded = decode(bytes)?;
    Ok((decoded.record().size, decoded.record().digest))
}

fn copy_bytes(bytes: &[u8]) -> Result<Vec<u8>, Errno> {
    let mut output = Vec::new();
    output.try_reserve_exact(bytes.len()).map_err(|_| Errno::ENOMEM)?;
    output.extend_from_slice(bytes);
    Ok(output)
}

pub(super) fn archive_source_identity(bytes: &[u8]) -> Result<Option<[u8; 32]>, Errno> {
    fn field(digest: &mut Sha256, bytes: &[u8]) {
        digest.update((bytes.len() as u64).to_le_bytes());
        digest.update(bytes);
    }
    let decoded = decode(bytes)?;
    let Some(archive) = decoded.section.archives.first() else { return Ok(None); };
    let record = decoded.record();
    let mut digest = Sha256::new();
    digest.update(b"Kandelo archive source identity v1\0");
    digest.update(record.size.to_le_bytes());
    digest.update(record.digest);
    field(&mut digest, &record.source_path);
    field(&mut digest, &record.uri);
    field(&mut digest, &record.payload);
    digest.update(archive.bytes.to_le_bytes());
    digest.update(archive.digest);
    field(&mut digest, &archive.uri);
    field(&mut digest, &archive.payload);
    Ok(Some(digest.finalize().into()))
}

pub(super) fn describe(state: &RootfsState, inode: &Inode, digest: [u8; 32]) -> Result<OwnedMetadata, Errno> {
    if !inode.persistent_provider.is_empty() {
        let (size, expected) = identity(&inode.persistent_provider)?;
        if size != inode.stat().st_size || expected != digest { return Err(Errno::EIO); }
        return own_metadata(&inode.persistent_provider);
    }
    let (size, archive_id, source_path) = match &inode.kind {
        InodeKind::LazyMember { size, archive_id, source_path } => (*size, *archive_id, source_path.as_ref()),
        InodeKind::BaseRegular { size, source: BaseSource::Host, .. }
            if inode.deferred_base || !inode.deferred_payload.is_empty() => (*size, 0, &[][..]),
        _ => return Err(Errno::EINVAL),
    };
    let archive = if archive_id == 0 { None } else { Some(state.archives.get(&archive_id).ok_or(Errno::EIO)?) };
    let length = source_path.len().checked_add(inode.deferred_uri.len())
        .and_then(|length| length.checked_add(inode.deferred_payload.len()))
        .and_then(|length| length.checked_add(archive.map_or(0, |archive| archive.uri.len() + archive.payload.len())))
        .and_then(|length| length.checked_add(256)).ok_or(Errno::ENOMEM)?;
    if length > crate::persistent_overlay::MAX_INODE_RECORD_BYTES - PERSISTENT_REGULAR_RECORD_BYTES { return Err(Errno::E2BIG); }
    let _scratch = ROOTFS_METADATA.reserve_temporary(length.checked_mul(6).ok_or(Errno::ENOMEM)?)?;
    let record = DeferredRecord {
        ino: 1, size, archive_id, source_path: copy_bytes(source_path)?,
        uri: copy_bytes(&inode.deferred_uri)?, digest, payload: copy_bytes(&inode.deferred_payload)?,
    };
    let archives = archive.map(|archive| Ok::<_, Errno>(DeferredArchive {
        archive_id, bytes: archive.size, uri: copy_bytes(&archive.uri)?,
        digest: archive.digest, payload: copy_bytes(&archive.payload)?,
    })).transpose()?;
    let encoded = crate::sdef::encode(archives.as_slice(), &[record])?;
    decode(&encoded)?;
    own_metadata(&encoded)
}

pub(super) fn decode(bytes: &[u8]) -> Result<Decoded, Errno> {
    if bytes.len()
        > crate::persistent_overlay::MAX_INODE_RECORD_BYTES - PERSISTENT_REGULAR_RECORD_BYTES
    {
        return Err(Errno::EIO);
    }
    let mut reservation = ROOTFS_METADATA.reserve_temporary(0)?;
    let section = crate::sdef::decode_from_with_admission(
        bytes.len() as u64,
        crate::persistent_overlay::MAX_INODE_RECORD_BYTES,
        |offset, output| {
            let start = usize::try_from(offset).map_err(|_| Errno::EIO)?;
            let end = start.checked_add(output.len()).ok_or(Errno::EIO)?;
            output.copy_from_slice(bytes.get(start..end).ok_or(Errno::EIO)?);
            Ok(output.len())
        },
        |amount| {
            reservation.resize(
                reservation
                    .bytes()
                    .checked_add(amount)
                    .ok_or(Errno::ENOMEM)?,
            )
        },
    )
    .map_err(|error| {
        if error == Errno::ENOMEM {
            error
        } else {
            Errno::EIO
        }
    })?;
    if section.records.len() != 1 || section.archives.len() > 1 {
        return Err(Errno::EIO);
    }
    let record = &section.records[0];
    if record.ino != 1
        || record.size > i64::MAX as u64
        || record.digest == crate::sdef::DIGEST_NONE
        || (record.archive_id == 0) != section.archives.is_empty()
        || (record.archive_id == 0 && record.uri.is_empty())
        || section.archives.iter().any(|archive| {
            archive.uri.is_empty()
                || archive.bytes == 0
                || archive.bytes > i64::MAX as u64
                || archive.digest == crate::sdef::DIGEST_NONE
        })
    {
        return Err(Errno::EIO);
    }
    Ok(Decoded {
        section,
        _reservation: reservation,
    })
}

pub(super) fn inode(
    ino: u64,
    bytes: &[u8],
    metadata: PersistentInodeMetadata,
) -> Result<Inode, Errno> {
    let decoded = decode(bytes)?;
    let record = decoded.record();
    let kind = if record.archive_id == 0 {
        InodeKind::BaseRegular {
            blob_id: ino,
            size: record.size,
            source: BaseSource::Host,
        }
    } else {
        InodeKind::LazyMember {
            archive_id: record.archive_id,
            source_path: own_metadata(&record.source_path)?,
            size: record.size,
        }
    };
    let mut inode = Inode::new(kind, metadata.mode, metadata.uid, metadata.gid, 0, ino);
    inode.deferred_uri = own_metadata(&record.uri)?;
    inode.deferred_digest = record.digest;
    inode.deferred_payload = own_metadata(&record.payload)?;
    inode.persistent_provider = own_metadata(bytes)?;
    inode.deferred_base = record.archive_id == 0;
    metadata.apply(&mut inode);
    Ok(inode)
}

pub(super) fn matches_unhashed_archive_member(state: &RootfsState, inode: &Inode, provider: &[u8], size: u64, digest: [u8; 32]) -> Result<bool, Errno> {
    if inode.deferred_digest != crate::sdef::DIGEST_NONE { return Ok(false); }
    let InodeKind::LazyMember { archive_id, source_path, size: actual_size } = &inode.kind else { return Ok(false); };
    let decoded = decode(provider)?;
    let record = decoded.record();
    let Some(expected) = decoded.section.archives.first() else { return Ok(false); };
    let Some(actual) = state.archives.get(archive_id) else { return Err(Errno::EIO); };
    Ok(*actual_size == size && record.size == size && record.digest == digest
        && record.source_path.as_slice() == source_path.as_ref()
        && record.payload.as_slice() == inode.deferred_payload.as_ref()
        && archive_matches(actual, expected))
}

fn archive_matches(entry: &ArchiveEntry, archive: &DeferredArchive) -> bool {
    entry.size == archive.bytes
        && entry.uri.as_ref() == archive.uri.as_slice()
        && entry.digest == archive.digest
        && entry.payload.as_ref() == archive.payload.as_slice()
}

pub(super) fn remap_for_staging(bytes: &[u8]) -> Result<OwnedMetadata, Errno> {
    let mut decoded = decode(bytes)?;
    if let Some(archive) = decoded.section.archives.first_mut() {
        let identity = ROOTFS.with(|state| {
            if let Some((&identity, _)) = state.archives.iter().find(|(_, entry)| archive_matches(entry, archive)) {
                return Ok(identity);
            }
            if !state.archives.contains_key(&archive.archive_id) { return Ok(archive.archive_id); }
            let mut candidate = 1u32;
            for &identity in state.archives.keys() {
                if identity > candidate { break; }
                if identity == candidate { candidate = candidate.checked_add(1).ok_or(Errno::ENOSPC)?; }
            }
            Ok(candidate)
        })?;
        if identity != archive.archive_id {
            archive.archive_id = identity;
            decoded.section.records[0].archive_id = identity;
            let mut scratch = ROOTFS_METADATA.reserve_temporary(bytes.len().checked_mul(2).ok_or(Errno::ENOMEM)?)?;
            let encoded = crate::sdef::encode(&decoded.section.archives, &decoded.section.records)?;
            scratch.resize(encoded.capacity().checked_mul(2).ok_or(Errno::ENOMEM)?)?;
            return own_metadata(&encoded);
        }
    }
    own_metadata(bytes)
}

pub(super) fn prepare_archives<'a>(
    state: &RootfsState,
    inodes: impl Iterator<Item = &'a Inode> + Clone,
) -> Result<Option<BTreeMap<u32, ArchiveEntry>>, Errno> {
    let mut needed = false;
    for inode in inodes
        .clone()
        .filter(|inode| !inode.persistent_provider.is_empty())
    {
        let decoded = decode(&inode.persistent_provider)?;
        for archive in &decoded.section.archives {
            match state.archives.get(&archive.archive_id) {
                Some(existing) if archive_matches(existing, archive) => {}
                Some(_) => return Err(Errno::EIO),
                None => needed = true,
            }
        }
    }
    if !needed {
        return Ok(None);
    }
    let mut archives = BTreeMap::new();
    for (&id, entry) in &state.archives {
        archives.insert(
            id,
            ArchiveEntry::new(entry.size, &entry.uri, entry.digest, &entry.payload)?,
        );
    }
    for inode in inodes.filter(|inode| !inode.persistent_provider.is_empty()) {
        let decoded = decode(&inode.persistent_provider)?;
        for archive in &decoded.section.archives {
            if let Some(existing) = archives.get(&archive.archive_id) {
                if !archive_matches(existing, archive) {
                    return Err(Errno::EIO);
                }
            } else {
                archives.insert(
                    archive.archive_id,
                    ArchiveEntry::new(
                        archive.bytes,
                        &archive.uri,
                        archive.digest,
                        &archive.payload,
                    )?,
                );
            }
        }
    }
    Ok(Some(archives))
}

pub(super) fn section_bytes_after(
    state: &RootfsState,
    retired: &[u32],
    mutations: &[Mutation],
) -> Result<u64, Errno> {
    let mut bytes = persistent_deferred_section_bytes(state, retired)?;
    let mut added_archives = crate::IoBuffer::try_with_capacity(mutations.len())?;
    for mutation in mutations {
        let Mutation::Put {
            key: OverlayKey::Inode(_),
            value,
        } = mutation
        else {
            continue;
        };
        if value.get(1) != Some(&7) {
            continue;
        }
        let decoded = decode(&value[PERSISTENT_REGULAR_RECORD_BYTES..])?;
        let record = decoded.record();
        let length = u64::from(crate::sdef::RECORD_HEADER_SIZE)
            + record.source_path.len() as u64
            + record.uri.len() as u64
            + record.payload.len() as u64;
        bytes = bytes
            .checked_add(length.div_ceil(4) * 4)
            .ok_or(Errno::EIO)?;
        for archive in &decoded.section.archives {
            let retained = state.inodes.iter().enumerate().any(|(index, inode)| {
                !retired.contains(&(index as u32)) && inode.as_ref().is_some_and(|inode|
                    matches!(inode.kind, InodeKind::LazyMember { archive_id, .. } if archive_id == archive.archive_id))
            });
            if !retained && !added_archives.contains(&archive.archive_id) {
                let length = u64::from(crate::sdef::ARCHIVE_ENTRY_SIZE)
                    + archive.uri.len() as u64
                    + archive.payload.len() as u64;
                bytes = bytes
                    .checked_add(length.div_ceil(4) * 4)
                    .ok_or(Errno::EIO)?;
                added_archives.push(archive.archive_id);
            }
        }
    }
    Ok(bytes)
}

pub(super) fn stage(
    path: &[u8],
    provider: &[u8],
    mode: u32,
    uid: u32,
    gid: u32,
) -> Result<u64, Errno> {
    if !resizable_persistence_enabled() {
        return Err(Errno::EOPNOTSUPP);
    }
    if path.first() != Some(&b'/')
        || path.len() > 4096
        || path
            .split(|byte| *byte == b'/')
            .any(|part| part == b"." || part == b"..")
        || path_under_foreign(path)
    {
        return Err(Errno::EINVAL);
    }
    if mode & !0o1777 != 0 {
        return Err(Errno::EPERM);
    }
    sync_persistence()?;
    let (parent, name, parent_ino, mut inode, archives) = ROOTFS.with(|state| {
        if state
            .inodes
            .iter()
            .flatten()
            .any(|inode| inode.open_count != 0 || inode.map_pins != 0)
        {
            return Err(Errno::EBUSY);
        }
        let components = split_components(path);
        let (parent, name, target) = state.resolve(&components)?;
        if target.is_some() {
            return Err(Errno::EEXIST);
        }
        let name = own_metadata(name.ok_or(Errno::EINVAL)?)?;
        crate::persistent_overlay::validate_dirent_name(
            state.get(parent).ok_or(Errno::EIO)?.ino,
            &name,
        )?;
        state.require_image_inode_slot()?;
        if state.next_ino == u64::MAX {
            return Err(Errno::ENOSPC);
        }
        let metadata = PersistentInodeMetadata::from_inode(&Inode::new(
            InodeKind::PersistentRegular,
            mode,
            uid,
            gid,
            1,
            state.next_ino,
        ));
        let inode = inode(state.next_ino, provider, metadata)?;
        let archives = prepare_archives(state, core::iter::once(&inode))?;
        Ok((
            parent,
            name,
            state.get(parent).ok_or(Errno::EIO)?.ino,
            inode,
            archives,
        ))
    })?;
    let ino = inode.ino;
    let mut mutations = crate::persistent_overlay::MutationBatch::new(2)?;
    mutations.push_with(
        PERSISTENT_REGULAR_RECORD_BYTES
            .checked_add(provider.len())
            .ok_or(Errno::ENOMEM)?,
        || {
            Ok(Mutation::Put {
                key: OverlayKey::Inode(ino),
                value: encode_persistent_inode(&inode)?,
            })
        },
    )?;
    mutations.push_with(name.len().checked_add(8).ok_or(Errno::ENOMEM)?, || {
        let mut owned_name = Vec::new();
        owned_name
            .try_reserve_exact(name.len())
            .map_err(|_| Errno::ENOMEM)?;
        owned_name.extend_from_slice(&name);
        let mut value = Vec::new();
        value.try_reserve_exact(8).map_err(|_| Errno::ENOMEM)?;
        value.extend_from_slice(&ino.to_le_bytes());
        Ok(Mutation::Put {
            key: OverlayKey::Dirent {
                parent: parent_ino,
                name: owned_name,
            },
            value,
        })
    })?;
    let mut allocated = commit_persistent_namespace(
        mutations.as_slice(),
        &[(parent, NamespaceTimestamp::Modified)],
    )?;
    ROOTFS.with(|state| {
        inode.nlink = 1;
        state.bump_next_ino(ino);
        let index = state.insert_prepared_inode(inode);
        allocated
            .insert_into(state, parent, &name, index)
            .expect("prepared provider name missing");
        if let Some(archives) = archives {
            state.archives = archives;
        }
        state.persistent_allocated_blocks = Some(allocated.allocated);
    });
    Ok(ino)
}
