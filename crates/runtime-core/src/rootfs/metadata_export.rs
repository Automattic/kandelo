use super::*;
use crate::IoBuffer;
use crate::directory_entries::DirectoryIter;

struct Frame<'a> {
    entries: DirectoryIter<'a>,
    path_length: usize,
}

struct Walk<'a> {
    frames: IoBuffer<Frame<'a>>,
    path: IoBuffer<u8>,
}

impl<'a> Walk<'a> {
    fn new() -> Self { Self { frames: IoBuffer::new(), path: IoBuffer::new() } }

    fn visit(&mut self, state: &'a RootfsState, mut visit: impl FnMut(&Inode, &[u8]) -> Result<(), Errno>) -> Result<(), Errno> {
        self.frames.clear();
        self.path.clear();
        let Some(root) = state.root else { return Ok(()); };
        self.path.try_push(b'/')?;
        let mut current = root;
        loop {
            let inode = state.get(current).ok_or(Errno::EIO)?;
            visit(inode, &self.path)?;
            if let InodeKind::Dir(entries) = &inode.kind {
                if self.frames.len() >= state.inodes.len() { return Err(Errno::EIO); }
                self.frames.try_push(Frame { entries: entries.iter(), path_length: self.path.len() })?;
            }
            loop {
                let Some(frame) = self.frames.last_mut() else { return Ok(()); };
                if let Some((name, child)) = frame.entries.next() {
                    self.path.truncate(frame.path_length);
                    if self.path.len() > 1 { self.path.try_push(b'/')?; }
                    self.path.try_reserve(name.len())?;
                    self.path.extend_from_slice(name);
                    current = *child;
                    break;
                }
                self.frames.pop();
            }
        }
    }
}

struct Sink<'a> {
    output: Option<&'a mut [u8]>,
    start: usize,
    position: usize,
}

impl<'a> Sink<'a> {
    fn new(output: Option<&'a mut [u8]>, start: usize) -> Self {
        Self { output, start, position: 0 }
    }

    fn put(&mut self, bytes: &[u8]) -> Result<(), Errno> {
        let end = self.position.checked_add(bytes.len()).ok_or(Errno::ERANGE)?;
        if let Some(output) = &mut self.output {
            let output_end = self.start.checked_add(output.len()).ok_or(Errno::ERANGE)?;
            let from = self.position.max(self.start);
            let to = end.min(output_end);
            if from < to {
                output[from - self.start..to - self.start].copy_from_slice(&bytes[from - self.position..to - self.position]);
            }
        }
        self.position = end;
        Ok(())
    }

    fn u32(&mut self, value: u32) -> Result<(), Errno> { self.put(&value.to_le_bytes()) }
    fn u64(&mut self, value: u64) -> Result<(), Errno> { self.put(&value.to_le_bytes()) }
    fn bytes(&mut self, bytes: &[u8]) -> Result<(), Errno> {
        self.u32(u32::try_from(bytes.len()).map_err(|_| Errno::EINVAL)?)?;
        self.put(bytes)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct TreeSummary {
    pub(super) length: usize,
    entries: u32,
}

fn tree<'a>(state: &'a RootfsState, walk: &mut Walk<'a>, sink: &mut Sink<'_>, entries: u32) -> Result<u32, Errno> {
    sink.u32(EXPORT_MAGIC)?;
    sink.u32(EXPORT_VERSION)?;
    sink.u32(entries)?;
    let mut count = 0u32;
    walk.visit(state, |inode, path| {
        let (kind, target): (u8, &[u8]) = match &inode.kind {
            InodeKind::Dir(_) => (EXPORT_KIND_DIR, b""),
            InodeKind::BaseRegular { .. } => (EXPORT_KIND_BASE_REGULAR, b""),
            InodeKind::Regular(_) | InodeKind::PersistentRegular => (EXPORT_KIND_COW_REGULAR, b""),
            InodeKind::Symlink(target) => (EXPORT_KIND_SYMLINK, target),
            InodeKind::Special(_) => (EXPORT_KIND_SPECIAL, b""),
            InodeKind::LazyMember { .. } => (EXPORT_KIND_LAZY_MEMBER, b""),
        };
        sink.put(&[kind])?;
        sink.u32(inode.mode & 0o7777)?;
        sink.u32(inode.uid)?;
        sink.u32(inode.gid)?;
        sink.u64(inode.mtime_sec)?;
        sink.u32(inode.mtime_nsec)?;
        sink.u64(inode.stat().st_size)?;
        sink.bytes(path)?;
        sink.bytes(target)?;
        count = count.checked_add(1).ok_or(Errno::ERANGE)?;
        Ok(())
    })?;
    Ok(count)
}

pub(super) fn read_tree(offset: usize, output: &mut [u8], expected: Option<TreeSummary>) -> Result<(TreeSummary, usize), Errno> {
    ROOTFS.with(|state| {
        let mut walk = Walk::new();
        let mut probe = Sink::new(None, 0);
        let entries = tree(state, &mut walk, &mut probe, 0)?;
        let summary = TreeSummary { length: probe.position, entries };
        if expected.is_some_and(|expected| expected != summary) { return Err(Errno::EBUSY); }
        let count = output.len().min(summary.length.saturating_sub(offset));
        let mut sink = Sink::new(Some(&mut output[..count]), offset);
        tree(state, &mut walk, &mut sink, entries)?;
        Ok((summary, count))
    })
}

fn lazy<'a>(state: &'a RootfsState, walk: &mut Walk<'a>, sink: &mut Sink<'_>, file_count: u32) -> Result<u32, Errno> {
    sink.u32(file_count)?;
    sink.u32(u32::try_from(state.archives.len()).map_err(|_| Errno::EINVAL)?)?;
    let mut count = 0u32;
    walk.visit(state, |inode, path| {
        let (size, archive, source_path) = match &inode.kind {
            InodeKind::LazyMember { archive_id, source_path, size } => (*size, *archive_id, source_path.as_slice()),
            InodeKind::BaseRegular { size, source: BaseSource::Host, .. }
                if inode.deferred_base || !inode.deferred_payload.is_empty() => (*size, 0, &[][..]),
            _ => return Ok(()),
        };
        sink.bytes(path)?;
        sink.u64(inode.ino)?;
        sink.u64(size)?;
        sink.u32(archive)?;
        sink.bytes(source_path)?;
        sink.bytes(&inode.deferred_payload)?;
        sink.bytes(&inode.deferred_uri)?;
        sink.bytes(&inode.deferred_digest)?;
        count = count.checked_add(1).ok_or(Errno::EINVAL)?;
        Ok(())
    })?;
    for (id, archive) in &state.archives {
        sink.u32(*id)?;
        sink.u64(archive.size)?;
        sink.bytes(&archive.payload)?;
        sink.bytes(&archive.uri)?;
        sink.bytes(&archive.digest)?;
    }
    Ok(count)
}

pub(super) fn serialize_lazy(output: Option<&mut [u8]>) -> Result<usize, Errno> {
    ROOTFS.with(|state| {
        let mut walk = Walk::new();
        let mut probe = Sink::new(None, 0);
        let files = lazy(state, &mut walk, &mut probe, 0)?;
        let length = probe.position;
        i32::try_from(length).map_err(|_| Errno::ERANGE)?;
        if let Some(output) = output {
            if output.len() < length { return Err(Errno::ERANGE); }
            let mut sink = Sink::new(Some(&mut output[..length]), 0);
            lazy(state, &mut walk, &mut sink, files)?;
        }
        Ok(length)
    })
}
