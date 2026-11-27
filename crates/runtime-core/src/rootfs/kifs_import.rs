//! Snapshot the quiescent legacy mount used by the boot importer. The staged
//! volume is opened through the KIFS v3 reader before it can be published.
use super::*;
use crate::IoBuffer;
use crate::kifs_v3::{
    BLOCK_BYTES, DEFERRED_FILE, IMAGE_METADATA, InodeRecord, Key, KifsNamespace, KifsVolume,
    KifsVolumeBuilder, ROOT_INODE, SYMLINK_TARGET, Timestamp,
};
use crate::positioned_storage::PositionedStorage;

struct SourceInode {
    number: u64,
    index: u32,
    parent: u64,
}

pub(super) fn stage<S: PositionedStorage>(
    target: S,
    capacity_blocks: u64,
    identity: [u8; 32],
    mut byte_source: impl FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>,
) -> Result<KifsNamespace<S>, Errno> {
    if PERSISTENT_ROOTFS
        .lock()
        .as_ref()
        .is_some_and(|mount| mount.journal.has_pending_writeback())
    {
        return Err(Errno::EBUSY);
    }
    let (nodes, next_inode) = source_inodes()?;
    let mut builder = KifsVolumeBuilder::new(target, capacity_blocks, identity)?;
    for node in &*nodes {
        let stat = ROOTFS.with(|state| state.get(node.index).map(Inode::stat).ok_or(Errno::EIO))?;
        let mut data_blocks = 0;
        if let Some((size, content)) = content_for_inode(node)? {
            let source = core::cell::RefCell::new(&mut byte_source);
            each_block_batch(node, &content, size, &source, |blocks| {
                data_blocks += blocks.len() as u64;
                Ok(())
            })?;
        }
        let record = inode_record(stat, node.parent, data_blocks);
        builder.push_metadata(Key::Inode(node.number), &record.encode()?)?;
    }
    ROOTFS.with(|state| {
        for node in &*nodes {
            let inode = state.get(node.index).ok_or(Errno::EIO)?;
            if let InodeKind::Dir(entries) = &inode.kind {
                for (name, index) in entries.iter() {
                    if matches!(name.as_slice(), b"." | b"..") {
                        continue;
                    }
                    let child = state.get(*index).ok_or(Errno::EIO)?;
                    let key = Key::Dirent {
                        parent: node.number,
                        name,
                    };
                    builder.push_metadata(key, &child.ino.to_le_bytes())?;
                }
            }
        }
        Ok::<_, Errno>(())
    })?;
    let mut block = IoBuffer::try_filled(BLOCK_BYTES, 0)?;
    for node in &*nodes {
        visit_file_blocks(node, &mut block, &mut byte_source, |number, bytes| {
            builder.push_block(node.number, number, bytes)
        })?;
    }
    visit_attributes(&nodes, |key, bytes| builder.push_metadata(key, bytes))?;
    drop(nodes);
    drop(block);
    let storage = builder.finish(next_inode)?.into_storage();
    let staged = KifsVolume::open(storage, identity)?;
    trial_mount(staged, capacity_blocks, &mut byte_source)
}

pub(super) fn trial_mount<S: PositionedStorage>(
    mut volume: KifsVolume<S>,
    capacity_blocks: u64,
    source: &mut impl FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>,
) -> Result<KifsNamespace<S>, Errno> {
    let (nodes, next_inode) = source_inodes()?;
    let records = volume.verified_record_count()?;
    let mut expected_records = nodes.len() as u64;
    if volume.usage().capacity_blocks != capacity_blocks || volume.next_inode() != next_inode {
        return Err(Errno::EIO);
    }
    let mut copied = IoBuffer::try_filled(BLOCK_BYTES, 0)?;
    let mut original = IoBuffer::try_filled(BLOCK_BYTES, 0)?;
    visit_attributes(&nodes, |key, bytes| {
        expected_records += 1;
        if volume.lookup(key, &mut copied)? != Some(bytes.len()) || &copied[..bytes.len()] != bytes
        {
            return Err(Errno::EIO);
        }
        Ok(())
    })?;
    let mut candidate = KifsNamespace::open(volume)?;
    let mut total = 0u64;
    // Walk allocated source extents, including allocated all-zero blocks. A
    // sparse file's apparent length must never determine trial I/O or RAM.
    for node in &*nodes {
        let mut blocks = 0u64;
        visit_file_blocks(node, &mut original, source, |number, bytes| {
            if !candidate.read_allocated_block(
                node.number,
                number,
                (&mut copied[..]).try_into().unwrap(),
            )? || &copied[..] != bytes
            {
                return Err(Errno::EIO);
            }
            blocks += 1;
            Ok(())
        })?;
        if candidate.inode(node.number)?.ok_or(Errno::EIO)?.data_blocks != blocks {
            return Err(Errno::EIO);
        }
        total = total.checked_add(blocks).ok_or(Errno::EIO)?;
    }
    if total != candidate.usage().data_blocks {
        return Err(Errno::EIO);
    }
    expected_records += total + verify_namespace(&mut candidate, &nodes)?;
    if expected_records != records {
        return Err(Errno::EIO);
    }
    Ok(candidate)
}

fn inode_record(stat: WasmStat, parent: u64, data_blocks: u64) -> InodeRecord {
    InodeRecord {
        mode: stat.st_mode,
        uid: stat.st_uid,
        gid: stat.st_gid,
        links: stat.st_nlink,
        size: stat.st_size,
        parent,
        device: stat.st_rdev,
        data_blocks,
        accessed: Timestamp {
            seconds: stat.st_atime_sec,
            nanoseconds: stat.st_atime_nsec,
        },
        modified: Timestamp {
            seconds: stat.st_mtime_sec,
            nanoseconds: stat.st_mtime_nsec,
        },
        changed: Timestamp {
            seconds: stat.st_ctime_sec,
            nanoseconds: stat.st_ctime_nsec,
        },
    }
}

fn verify_namespace(
    candidate: &mut KifsNamespace<impl PositionedStorage>,
    nodes: &[SourceInode],
) -> Result<u64, Errno> {
    let mut dirents = 0u64;
    let mut symlink = IoBuffer::new();
    ROOTFS.with(|state| {
        for node in nodes {
            let original = state.get(node.index).ok_or(Errno::EIO)?;
            let copied = candidate.inode(node.number)?.ok_or(Errno::EIO)?;
            if copied != inode_record(original.stat(), node.parent, copied.data_blocks) {
                return Err(Errno::EIO);
            }
            match &original.kind {
                InodeKind::Dir(entries) => {
                    let mut expected = entries
                        .iter()
                        .filter(|(name, _)| !matches!(name.as_slice(), b"." | b".."));
                    candidate.for_directory(node.number, None, |name, inode| {
                        let (expected_name, expected_slot) = expected.next().ok_or(Errno::EIO)?;
                        if name != expected_name.as_slice()
                            || state.get(*expected_slot).ok_or(Errno::EIO)?.ino != inode
                        {
                            return Err(Errno::EIO);
                        }
                        dirents += 1;
                        Ok(())
                    })?;
                    if expected.next().is_some() {
                        return Err(Errno::EIO);
                    }
                }
                InodeKind::Symlink(target) => {
                    symlink.try_reserve_exact(target.len().saturating_sub(symlink.len()))?;
                    symlink.resize(target.len(), 0);
                    let length = candidate.read_link(node.number, &mut symlink)?;
                    if length != target.len() || &*symlink != target.as_slice() {
                        return Err(Errno::EIO);
                    }
                }
                _ => {}
            }
        }
        Ok(dirents)
    })
}

fn visit_attributes(
    nodes: &[SourceInode],
    mut visit: impl FnMut(Key<'_>, &[u8]) -> Result<(), Errno>,
) -> Result<(), Errno> {
    ROOTFS.with(|state| {
        if let Some(metadata) = &state.image_metadata {
            visit_stream(
                &mut visit,
                |chunk| Key::Attribute {
                    inode: ROOT_INODE,
                    kind: IMAGE_METADATA,
                    chunk,
                },
                &[metadata.as_slice()],
            )?;
        }
        for node in nodes {
            let inode = state.get(node.index).ok_or(Errno::EIO)?;
            let (archive, path) = match &inode.kind {
                InodeKind::Symlink(target) => {
                    visit_stream(
                        &mut visit,
                        |chunk| Key::Attribute {
                            inode: node.number,
                            kind: SYMLINK_TARGET,
                            chunk,
                        },
                        &[target.as_slice()],
                    )?;
                    continue;
                }
                InodeKind::LazyMember {
                    archive_id,
                    source_path,
                    ..
                } => (*archive_id, source_path.as_slice()),
                InodeKind::BaseRegular {
                    source: BaseSource::Host,
                    ..
                } if inode.deferred_base => (0, &[][..]),
                _ => continue,
            };
            let payload = inode.deferred_payload.as_slice();
            let uri = inode.deferred_uri.as_slice();
            let header = [
                archive.to_le_bytes(),
                stream_length(path)?,
                stream_length(uri)?,
                stream_length(payload)?,
            ];
            visit_stream(
                &mut visit,
                |chunk| Key::Attribute {
                    inode: node.number,
                    kind: DEFERRED_FILE,
                    chunk,
                },
                &[
                    header.as_flattened(),
                    &inode.deferred_digest,
                    path,
                    uri,
                    payload,
                ],
            )?;
        }
        for (id, archive) in &state.archives {
            let uri = archive.uri.as_slice();
            let payload = archive.payload.as_slice();
            visit_stream(
                &mut visit,
                |chunk| Key::Archive { id: *id, chunk },
                &[
                    &archive.size.to_le_bytes(),
                    &stream_length(uri)?,
                    &stream_length(payload)?,
                    &archive.digest,
                    uri,
                    payload,
                ],
            )?;
        }
        Ok(())
    })
}

fn stream_length(bytes: &[u8]) -> Result<[u8; 4], Errno> {
    u32::try_from(bytes.len())
        .map(u32::to_le_bytes)
        .map_err(|_| Errno::EFBIG)
}

fn visit_stream<'a>(
    visit: &mut impl FnMut(Key<'a>, &[u8]) -> Result<(), Errno>,
    key: impl Fn(u32) -> Key<'a>,
    segments: &[&[u8]],
) -> Result<(), Errno> {
    let mut chunk = 0u32;
    let mut buffer = [0; crate::filesystem_tree::MAX_VALUE_BYTES];
    let mut length = 0;
    for mut segment in segments.iter().copied() {
        while !segment.is_empty() {
            let count = (buffer.len() - length).min(segment.len());
            buffer[length..length + count].copy_from_slice(&segment[..count]);
            segment = &segment[count..];
            length += count;
            if length == buffer.len() {
                visit(key(chunk), &buffer)?;
                chunk = chunk.checked_add(1).ok_or(Errno::EFBIG)?;
                length = 0;
            }
        }
    }
    if length != 0 {
        visit(key(chunk), &buffer[..length])?;
    }
    Ok(())
}

fn source_inodes() -> Result<(IoBuffer<SourceInode>, u64), Errno> {
    ROOTFS.with(|state| {
        let root = state
            .root
            .and_then(|index| state.get(index))
            .ok_or(Errno::EIO)?;
        if root.ino != ROOT_INODE || root.nlink == 0 {
            return Err(Errno::EIO);
        }
        let mut nodes = IoBuffer::new();
        // Each live inode in a legacy mount is already resident. The sort
        // uses bounded admission and retains only numbers and arena slots.
        for (index, inode) in state
            .inodes
            .iter()
            .enumerate()
            .filter_map(|(index, inode)| inode.as_ref().map(|inode| (index, inode)))
        {
            if inode.nlink == 0 {
                continue;
            }
            if !inode.deferred_base
                && matches!(
                    inode.kind,
                    InodeKind::BaseRegular {
                        source: BaseSource::Host,
                        ..
                    }
                )
            {
                // A host-only file without an image descriptor has no stable
                // source identity to persist into the new volume.
                return Err(Errno::ENOTSUP);
            }
            nodes.try_push(SourceInode {
                number: inode.ino,
                index: u32::try_from(index).map_err(|_| Errno::EIO)?,
                parent: 0,
            })?;
        }
        nodes.sort_unstable_by_key(|node| node.number);
        if nodes
            .windows(2)
            .any(|items| items[0].number == items[1].number)
        {
            return Err(Errno::EIO);
        }
        nodes[0].parent = ROOT_INODE;
        for position in 0..nodes.len() {
            let parent = nodes[position].number;
            let inode = state.get(nodes[position].index).ok_or(Errno::EIO)?;
            if let InodeKind::Dir(entries) = &inode.kind {
                for (name, index) in entries.iter() {
                    if matches!(name.as_slice(), b"." | b"..") {
                        continue;
                    }
                    let child = state.get(*index).ok_or(Errno::EIO)?;
                    if child.is_dir() {
                        let slot = nodes
                            .binary_search_by_key(&child.ino, |node| node.number)
                            .map_err(|_| Errno::EIO)?;
                        if nodes[slot].parent != 0 {
                            return Err(Errno::EIO);
                        }
                        nodes[slot].parent = parent;
                    }
                }
            }
        }
        Ok((nodes, state.next_ino))
    })
}

fn visit_file_blocks<F>(
    node: &SourceInode,
    block: &mut [u8],
    source: &mut F,
    mut visit: impl FnMut(u64, &[u8; BLOCK_BYTES]) -> Result<(), Errno>,
) -> Result<(), Errno>
where
    F: FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>,
{
    use crate::kandelo_image_write::ContentSource;
    let Some((size, content)) = content_for_inode(node)? else {
        return Ok(());
    };
    let contents = [content];
    let reader = ExportContentSource {
        contents: &contents,
        byte_source: core::cell::RefCell::new(source),
        image_read: core::cell::RefCell::new(ImageReadCursor::new()),
    };
    let mut save = |number: u32, reader: &ExportContentSource<'_, F>| {
        let offset = u64::from(number) * BLOCK_BYTES as u64;
        let length = (size - offset).min(BLOCK_BYTES as u64) as usize;
        block.fill(0);
        reader.read_exact_at(0, offset, &mut block[..length])?;
        visit(u64::from(number), (&*block).try_into().unwrap())
    };
    each_block_batch(node, &contents[0], size, &reader.byte_source, |numbers| {
        for number in numbers {
            save(*number, &reader)?;
        }
        Ok(())
    })
}

fn content_for_inode(node: &SourceInode) -> Result<Option<(u64, ImageContent)>, Errno> {
    let mounted = PERSISTENT_ROOTFS.lock().is_some();
    ROOTFS.with(|state| {
        let inode = state.get(node.index).ok_or(Errno::EIO)?;
        let size = inode.apparent_size();
        let content = match inode.kind {
            InodeKind::Regular(_) => ImageContent::Overlay(node.index),
            InodeKind::BaseRegular {
                blob_id,
                size,
                source: BaseSource::Image,
            } if mounted => ImageContent::Persistent {
                inode: inode.ino,
                image_inode: Some(image_ino(blob_id)?),
                base_size: size,
            },
            InodeKind::BaseRegular {
                blob_id,
                source: BaseSource::Image,
                ..
            } => ImageContent::Image(image_ino(blob_id)?),
            InodeKind::PersistentRegular => ImageContent::Persistent {
                inode: inode.ino,
                image_inode: None,
                base_size: 0,
            },
            _ => return Ok::<_, Errno>(None),
        };
        Ok(Some((size, content)))
    })
}

fn each_block_batch<F>(
    node: &SourceInode,
    content: &ImageContent,
    size: u64,
    source: &core::cell::RefCell<&mut F>,
    mut visit: impl FnMut(&[u32]) -> Result<(), Errno>,
) -> Result<(), Errno>
where
    F: FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>,
{
    let limit = size.div_ceil(BLOCK_BYTES as u64);
    let mut next = 0;
    let mut batch = [0; 64];
    while next < limit {
        let count = collect_blocks(
            node,
            content,
            next..limit,
            &mut **source.borrow_mut(),
            &mut batch,
        )?;
        if count == 0 {
            break;
        }
        visit(&batch[..count])?;
        next = u64::from(batch[count - 1]) + 1;
    }
    Ok(())
}

fn collect_blocks<F>(
    node: &SourceInode,
    content: &ImageContent,
    range: core::ops::Range<u64>,
    source: &mut F,
    batch: &mut [u32],
) -> Result<usize, Errno>
where
    F: FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>,
{
    let mut count = 0;
    let mut visit = |block| {
        batch[count] = block;
        count += 1;
        Ok(count < batch.len())
    };
    let mut persistent = PERSISTENT_ROOTFS.lock();
    ROOTFS.with(|state| {
        let inode = state.get(node.index).ok_or(Errno::EIO)?;
        match *content {
            ImageContent::Persistent { base_size, .. } => {
                let mount = persistent.as_mut().ok_or(Errno::EIO)?;
                visit_composed_inode_allocations(
                    &mut mount.journal,
                    inode,
                    state.image,
                    base_size,
                    inode.apparent_size(),
                    range,
                    source,
                    visit,
                )?;
            }
            ImageContent::Image(image) if !inode.base_dense => {
                with_image_file_allocations(
                    state.image.ok_or(Errno::EIO)?,
                    image,
                    range,
                    source,
                    |next_base| {
                        while let Some(block) = next_base()? {
                            if !visit(block)? {
                                break;
                            }
                        }
                        Ok(())
                    },
                )?;
            }
            ImageContent::Image(_) | ImageContent::Overlay(_) => {
                for block in range {
                    if !visit(u32::try_from(block).map_err(|_| Errno::EFBIG)?)? {
                        break;
                    }
                }
            }
        }
        Ok::<_, Errno>(())
    })?;
    Ok(count)
}
