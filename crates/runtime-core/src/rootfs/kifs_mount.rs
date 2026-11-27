//! The standalone KIFS volume behind the guest rootfs dispatch.

use super::*;
use crate::kifs_v3::{InodeRecord, KifsNamespace, KifsVolume, ROOT_INODE, Timestamp};
use crate::positioned_storage::PositionedStorage;

use crate::ofd::OfdPath;

pub(super) struct MountedKifs {
    pub(super) directory_paths: crate::IoBuffer<(u64, OfdPath)>,
    pub(super) namespace: KifsNamespace<Box<dyn PositionedStorage + Send>>,
}

pub(super) enum OpenTarget<'a> {
    Existing(u64, InodeRecord),
    Create { parent: u64, name: &'a [u8] },
}

impl MountedKifs {
    pub(super) fn open(
        storage: Box<dyn PositionedStorage + Send>,
        identity: [u8; 32],
    ) -> Result<Self, Errno> {
        let mut namespace = KifsNamespace::open(KifsVolume::open(storage, identity)?)?;
        namespace.recover_orphans()?;
        namespace.enable_lookup_cache();
        namespace.enable_group_commit();
        Ok(Self {
            namespace,
            directory_paths: crate::IoBuffer::new(),
        })
    }

    pub(super) fn lookup(&mut self, components: &[&[u8]]) -> Result<(u64, InodeRecord), Errno> {
        self.namespace.walk(ROOT_INODE, components.iter().copied())
    }

    pub(super) fn inode(&mut self, number: u64) -> Result<InodeRecord, Errno> {
        self.namespace.inode(number)?.ok_or(Errno::EIO)
    }

    pub(super) fn archive(&mut self, id: u32) -> Result<(u64, [u8; 32], Vec<u8>), Errno> {
        let archive = self.namespace.archive(id)?;
        Ok((archive.reference, archive.digest, archive.address.to_vec()))
    }

    pub(super) fn directory_handle_path(&self, inode: &Inode) -> Result<OfdPath, Errno> {
        if !inode.is_dir() {
            return Err(Errno::ENOTDIR);
        }
        if inode.nlink == 0 {
            return Err(Errno::ENOENT);
        }
        self.directory_paths.iter()
            .find(|(number, _)| *number == inode.ino)
            .map(|(_, path)| path.clone())
            .ok_or(Errno::EIO)
    }

    pub(super) fn getdents_for_inode(
        &mut self,
        number: u64,
        buf: &mut [u8],
        offset: i64,
        root_entries: &[(&[u8], u8, u64)],
    ) -> Result<(usize, i64, bool), Errno> {
        let record = self.inode(number)?;
        let extra = if number == ROOT_INODE { root_entries } else { &[] };
        self.getdents(number, record, buf, offset, extra)
    }

    pub(super) fn size(&mut self, number: u64) -> Result<i64, Errno> {
        let record = self.inode(number)?;
        if record.mode & S_IFMT != S_IFREG {
            return Err(Errno::EISDIR);
        }
        i64::try_from(record.size).map_err(|_| Errno::EOVERFLOW)
    }

    pub(super) fn symlink_target(
        &mut self,
        components: &[&[u8]],
    ) -> Result<Option<crate::IoBuffer<u8>>, Errno> {
        let (number, record) = self.lookup(components)?;
        if record.mode & S_IFMT != S_IFLNK {
            return Ok(None);
        }
        if record.size > wasm_posix_shared::platform_limits::PATH_MAX_BYTES as u64 {
            return Err(Errno::ENAMETOOLONG);
        }
        let mut target = crate::IoBuffer::try_filled(record.size as usize, 0)?;
        if self.namespace.read_link(number, &mut target)? != target.len() {
            return Err(Errno::EIO);
        }
        Ok(Some(target))
    }

    pub(super) fn write_file(
        &mut self,
        pins: &mut [Option<Inode>],
        index: u32,
        offset: u64,
        buf: &[u8],
    ) -> Result<usize, Errno> {
        let inode = pins.get_mut(index as usize).and_then(Option::as_mut).ok_or(Errno::EBADF)?;
        self.namespace.write_file(inode.ino, offset, buf, now_timestamp())?;
        if !buf.is_empty() {
            inode.content_gen = inode.content_gen.wrapping_add(1);
        }
        Ok(buf.len())
    }

    fn parent<'a>(&mut self, components: &[&'a [u8]]) -> Result<(u64, &'a [u8]), Errno> {
        let (&name, ancestors) = components.split_last().ok_or(Errno::EBUSY)?;
        let (parent, _) = self.lookup(ancestors)?;
        Ok((parent, name))
    }

    pub(super) fn create_named(
        &mut self,
        components: &[&[u8]],
        mode: u32,
        uid: u32,
        gid: u32,
        target: Option<&[u8]>,
    ) -> Result<(), Errno> {
        let (parent, name) = self.parent(components)?;
        let record = InodeRecord::new(mode, uid, gid, now_timestamp());
        self.namespace.create(parent, name, record, target)?;
        Ok(())
    }

    pub(super) fn update_metadata(
        &mut self,
        pins: &[Option<Inode>],
        target: MetadataTarget<'_>,
        update: impl FnOnce(&mut PersistentInodeMetadata) -> Result<(), Errno>,
    ) -> Result<(), Errno> {
        let number = match target {
            MetadataTarget::Path(path) => self.lookup(&split_components(path))?.0,
            MetadataTarget::Handle(handle) => {
                let index = file_handle_to_inode(handle)? as usize;
                pins.get(index).and_then(Option::as_ref).ok_or(Errno::EBADF)?.ino
            }
        };
        self.namespace.update_inode(number, |record| {
            let mut fields = PersistentInodeMetadata::from_kifs(record);
            update(&mut fields)?;
            fields.apply_to_kifs(record);
            Ok(())
        })
    }

    pub(super) fn statfs(&self) -> WasmStatfs {
        let usage = self.namespace.usage();
        let free = usage.capacity_blocks.saturating_sub(usage.allocated_blocks());
        WasmStatfs {
            f_type: crate::kandelo_image_fs::KANDELO_IMAGE_SUPER_MAGIC,
            f_bsize: crate::kifs_v3::BLOCK_BYTES as u32,
            f_blocks: usage.capacity_blocks,
            f_bfree: free,
            f_bavail: free,
            f_files: 0,
            f_ffree: 0,
            f_fsid: 0,
            f_namelen: 255,
            f_frsize: crate::kifs_v3::BLOCK_BYTES as u32,
            f_flags: if is_nosuid() { wasm_posix_shared::statfs_flags::ST_NOSUID } else { 0 },
            _pad: 0,
        }
    }

    pub(super) fn link(&mut self, old: &[&[u8]], new: &[&[u8]]) -> Result<(), Errno> {
        let (inode, _) = self.lookup(old)?;
        let (parent, name) = self.parent(new)?;
        self.namespace.link(inode, parent, name, now_timestamp())
    }

    pub(super) fn remove_name(
        &mut self,
        path: &[&[u8]],
        directory: bool,
        pins: &mut [Option<Inode>],
    ) -> Result<(), Errno> {
        let (parent, name) = self.parent(path)?;
        let mut pin = None;
        let (_, links) = self.namespace.remove_name_with_pin(
            parent, name, directory, now_timestamp(), |inode| {
                pin = pins.iter().position(|entry| entry.as_ref().is_some_and(|entry| entry.ino == inode));
                pin.is_some()
            },
        )?;
        // The VFS pin table is updated only after the transaction succeeds.
        if let Some(index) = pin {
            pins[index].as_mut().expect("the transaction cannot change the pin table").nlink = links;
        }
        Ok(())
    }

    pub(super) fn rename(
        &mut self,
        old: &[u8],
        new: &[u8],
        pins: &mut [Option<Inode>],
    ) -> Result<Option<u64>, Errno> {
        let origin = self.parent(&split_components(old))?;
        let (source, record) = self
            .namespace
            .lookup(origin.0, origin.1)?
            .ok_or(Errno::ENOENT)?;
        let target = self.parent(&split_components(new))?;
        let replaced = self.namespace.lookup(target.0, target.1)?;
        if replaced.is_some_and(|(number, _)| number == source) {
            return Ok(None);
        }
        // Only live directory descriptions own paths. Admit every replacement
        // before committing so an allocation error leaves the namespace intact.
        let mut moved = crate::IoBuffer::new();
        if record.mode & S_IFMT == S_IFDIR {
            for (index, (_, path)) in self.directory_paths.iter().enumerate() {
                if let Some(suffix) = path.strip_prefix(old) {
                    if suffix.is_empty() || suffix.starts_with(b"/") {
                        let mut bytes = crate::IoBuffer::try_with_capacity(
                            new.len().checked_add(suffix.len()).ok_or(Errno::ENOMEM)?,
                        )?;
                        bytes.extend_from_slice(new);
                        bytes.extend_from_slice(suffix);
                        moved.try_push((index, OfdPath::copy_from(&bytes)?))?;
                    }
                }
            }
        }
        let pin = replaced.and_then(|(number, record)| {
            pins.iter_mut()
                .flatten()
                .find(|inode| inode.ino == number)
                .map(|inode| (inode, record.links))
        });
        self.namespace
            .rename(origin, target, true, pin.is_some(), now_timestamp())?;
        if let Some((pin, links)) = pin {
            pin.nlink = if pin.is_dir() { 0 } else { links - 1 };
        }
        for (index, path) in moved.iter() {
            self.directory_paths[*index].1 = path.clone();
        }
        Ok(Some(source))
    }

    pub(super) fn open_target<'a>(
        &mut self,
        components: &[&'a [u8]],
        flags: u32,
    ) -> Result<OpenTarget<'a>, Errno> {
        let Some((&name, ancestors)) = components.split_last() else {
            return Err(Errno::EISDIR);
        };
        let (parent, _) = self.lookup(ancestors)?;
        let Some((inode, record)) = self.namespace.lookup(parent, name)? else {
            if flags & O_CREAT == 0 {
                return Err(Errno::ENOENT);
            }
            if flags & O_DIRECTORY != 0 {
                return Err(Errno::ENOTDIR);
            }
            return Ok(OpenTarget::Create { parent, name });
        };
        if flags & (O_CREAT | O_EXCL) == (O_CREAT | O_EXCL) {
            return Err(Errno::EEXIST);
        }
        match record.mode & S_IFMT {
            S_IFDIR => Err(Errno::EISDIR),
            S_IFLNK => Err(Errno::ELOOP),
            S_IFREG if flags & O_DIRECTORY != 0 => Err(Errno::ENOTDIR),
            S_IFREG => Ok(OpenTarget::Existing(inode, record)),
            _ => Err(Errno::ENXIO),
        }
    }

    pub(super) fn getdents(
        &mut self,
        inode: u64,
        record: InodeRecord,
        buf: &mut [u8],
        offset: i64,
        extra: &[(&[u8], u8, u64)],
    ) -> Result<(usize, i64, bool), Errno> {
        if offset < 0 {
            return Err(Errno::EINVAL);
        }
        if record.links == 0 {
            return Ok((0, offset, true));
        }
        if record.mode & S_IFMT != S_IFDIR {
            return Err(Errno::ENOTDIR);
        }

        let mut written = 0;
        let mut cookie = offset;
        let mut emit = |position: i64, ino: u64, kind: u8, name: &[u8]| {
            let next = position.checked_add(1).ok_or(Errno::EOVERFLOW)?;
            let count = crate::procfs::write_dirent64(buf, written, ino, next, kind, name);
            if count == 0 {
                return if written == 0 {
                    Err(Errno::EINVAL)
                } else {
                    Ok(Some((written, position, false)))
                };
            }
            written += count;
            cookie = next;
            Ok(None)
        };
        for (position, ino, name) in [(0, inode, &b"."[..]), (1, record.parent, &b".."[..])] {
            if position >= offset {
                if let Some(full) = emit(position, ino, DT_DIR as u8, name)? {
                    return Ok(full);
                }
            }
        }
        let mut position = 2i64;
        for (index, &(name, kind, ino)) in extra.iter().enumerate() {
            if position >= offset
                && !extra[..index].iter().any(|(seen, _, _)| *seen == name)
                && self.namespace.lookup(inode, name)?.is_none()
            {
                if let Some(full) = emit(position, ino, kind, name)? {
                    return Ok(full);
                }
            }
            position = position.checked_add(1).ok_or(Errno::EOVERFLOW)?;
        }

        // The on-disk iterator resumes by name. Keep a bounded cursor while
        // walking to the numeric cookie used by getdents and seekdir.
        let mut prior = [0; 255];
        let mut prior_length = None;
        let mut name = [0; 255];
        while let Some((length, child, record)) =
            self.namespace
                .next_dirent(inode, prior_length.map(|n| &prior[..n]), &mut name)?
        {
            let name = &name[..length];
            if position >= offset {
                if let Some(full) = emit(position, child, dirent_type(record.mode), name)? {
                    return Ok(full);
                }
            }
            prior[..length].copy_from_slice(name);
            prior_length = Some(length);
            position = position.checked_add(1).ok_or(Errno::EOVERFLOW)?;
        }
        Ok((written, cookie, true))
    }
}

pub(super) fn now_timestamp() -> Timestamp {
    let (seconds, nanoseconds) = now();
    Timestamp {
        seconds,
        nanoseconds,
    }
}

impl PersistentInodeMetadata {
    pub(super) fn from_kifs(record: &InodeRecord) -> Self {
        Self {
            mode: record.mode & 0o7777,
            uid: record.uid,
            gid: record.gid,
            atime_sec: record.accessed.seconds,
            atime_nsec: record.accessed.nanoseconds,
            mtime_sec: record.modified.seconds,
            mtime_nsec: record.modified.nanoseconds,
            ctime_sec: record.changed.seconds,
            ctime_nsec: record.changed.nanoseconds,
        }
    }

    pub(super) fn apply_to_kifs(self, record: &mut InodeRecord) {
        record.mode = (record.mode & S_IFMT) | self.mode;
        record.uid = self.uid;
        record.gid = self.gid;
        record.accessed = Timestamp {
            seconds: self.atime_sec,
            nanoseconds: self.atime_nsec,
        };
        record.modified = Timestamp {
            seconds: self.mtime_sec,
            nanoseconds: self.mtime_nsec,
        };
        record.changed = Timestamp {
            seconds: self.ctime_sec,
            nanoseconds: self.ctime_nsec,
        };
    }
}

pub(super) fn stat(inode: u64, record: InodeRecord) -> WasmStat {
    WasmStat {
        st_dev: ROOTFS_DEV,
        st_ino: inode,
        st_mode: record.mode,
        st_nlink: record.links,
        st_uid: record.uid,
        st_gid: record.gid,
        st_size: record.size,
        st_atime_sec: record.accessed.seconds,
        st_atime_nsec: record.accessed.nanoseconds,
        st_mtime_sec: record.modified.seconds,
        st_mtime_nsec: record.modified.nanoseconds,
        st_ctime_sec: record.changed.seconds,
        st_ctime_nsec: record.changed.nanoseconds,
        st_rdev: record.device,
        _pad: 0,
    }
}

pub(super) fn dirent_type(mode: u32) -> u8 {
    ((mode & S_IFMT) >> 12) as u8
}


// Creating a name can require a slot for a new open description. Reserve that
// slot through the shared inode arena before committing the filesystem change.
pub(super) fn open_file(
    state: &mut RootfsState,
    components: &[&[u8]],
    flags: u32,
    mode: u32,
    uid: u32,
    gid: u32,
) -> Result<i64, Errno> {
    let kifs = state.kifs.as_mut().ok_or(Errno::EIO)?;
    let index = match kifs.open_target(components, flags)? {
        OpenTarget::Existing(number, record) => {
            let index = state.pin_kifs_inode(number, record, InodeKind::PersistentRegular)?;
            if flags & O_TRUNC != 0 && flags & O_ACCMODE != O_RDONLY {
                if let Err(error) = state.truncate_kifs(index, 0) {
                    state.get_mut(index).unwrap().open_count -= 1;
                    state.release_unreferenced_inode(index)?;
                    return Err(error);
                }
            }
            index
        }
        OpenTarget::Create { parent, name } => {
            // Prepare the live handle before making the name durable.
            state.reserve_inode_slots(1)?;
            let time = now_timestamp();
            let record = crate::kifs_v3::InodeRecord::new(S_IFREG | (mode & 0o1777), uid, gid, time);
            let kifs = state.kifs.as_mut().ok_or(Errno::EIO)?;
            let number = kifs.namespace.create(parent, name, record, None)?;
            let mut inode = Inode::new(InodeKind::PersistentRegular, mode & 0o1777, uid, gid, 1, number);
            inode.open_count = 1;
            state.insert_prepared_inode(inode)
        }
    };
    Ok(inode_to_file_handle(index))
}

pub(super) fn open_directory_handle(state: &mut RootfsState, path: &OfdPath) -> Result<i64, Errno> {
    let kifs = state.kifs.as_mut().ok_or(Errno::EIO)?;
    let (number, record) = kifs.lookup(&split_components(path))?;
    if record.mode & S_IFMT != S_IFDIR { return Err(Errno::ENOTDIR); }
    let add_path = !kifs.directory_paths.iter().any(|(id, _)| *id == number);
    if add_path { kifs.directory_paths.try_reserve(1)?; }
    let index = state.pin_kifs_inode(number, record, InodeKind::Dir(DirectoryEntries::new()))?;
    if add_path {
        state.kifs.as_mut().unwrap().directory_paths.push((number, path.clone()));
    }
    Ok(inode_to_file_handle(index))
}

pub(super) fn pin_directory(state: &mut RootfsState, comps: &[&[u8]]) -> Result<u32, Errno> {
    let kifs = state.kifs.as_mut().ok_or(Errno::EIO)?;
    let (number, record) = kifs.lookup(comps)?;
    if record.mode & S_IFMT != S_IFDIR {
        return Err(Errno::ENOTDIR);
    }
    state.pin_kifs_inode(number, record, InodeKind::Dir(DirectoryEntries::new()))
}

impl MountedKifs {
    pub(super) fn read_directory_entry(
        &mut self,
        directory: &Inode,
        iter: &mut DirIter,
        name_buf: &mut [u8],
    ) -> Result<Option<(u64, u32, usize)>, Errno> {
        let mut name = [0; 255];
        let next = self.namespace.next_dirent(directory.ino, iter.last_name.as_deref(), &mut name)?;
        let Some((length, number, record)) = next else {
            iter.exhausted = true;
            return Ok(None);
        };
        name_buf.get_mut(..length).ok_or(Errno::EINVAL)?.copy_from_slice(&name[..length]);
        iter.last_name = Some(name[..length].to_vec());
        Ok(Some((number, u32::from(dirent_type(record.mode)), length)))
    }
}

pub(super) fn release_unreferenced_inode(state: &mut RootfsState, index: u32) -> Result<(), Errno> {
    if state.get(index).is_some_and(|inode| inode.open_count == 0 && inode.map_pins == 0) {
        let inode = state.inodes[index as usize].take().unwrap();
        state.free_inodes.push(index);
        let kifs = state.kifs.as_mut().unwrap();
        if inode.is_dir() {
            kifs.directory_paths.retain(|(number, _)| *number != inode.ino);
        }
        if inode.nlink == 0 {
            return kifs.namespace.release_orphan(inode.ino);
        }
    }
    Ok(())
}

impl RootfsState {
    pub(super) fn pin_kifs_inode(
        &mut self,
        number: u64,
        record: crate::kifs_v3::InodeRecord,
        kind: InodeKind,
    ) -> Result<u32, Errno> {
        if let Some((index, inode)) = self.inodes.iter_mut().enumerate().find_map(|(index, slot)| {
            slot.as_mut().filter(|inode| inode.ino == number).map(|inode| (index, inode))
        }) {
            inode.open_count = inode.open_count.checked_add(1).ok_or(Errno::EOVERFLOW)?;
            return Ok(index as u32);
        }
        let mut inode = Inode::new(kind, record.mode & 0o7777, record.uid, record.gid, record.links, number);
        if matches!(inode.kind, InodeKind::PersistentRegular) {
            let namespace = &mut self.kifs.as_mut().ok_or(Errno::EIO)?.namespace;
            if let Some(file) = namespace.deferred_file(number)? {
                inode.deferred_digest = file.digest;
                inode.deferred_base = true;
                inode.kind = if file.reference == 0 {
                    inode.deferred_uri = own_metadata(&file.address)?;
                    InodeKind::BaseRegular { source: BaseSource::Host, blob_id: number, size: record.size }
                } else {
                    InodeKind::LazyMember {
                        archive_id: u32::try_from(file.reference).map_err(|_| Errno::EIO)?,
                        source_path: own_metadata(&file.address)?,
                        size: record.size,
                    }
                };
            }
        }
        inode.open_count = 1;
        self.insert_inode(inode)
    }

    pub(super) fn truncate_kifs(&mut self, index: u32, length: i64) -> Result<(), Errno> {
        let size = u64::try_from(length).map_err(|_| Errno::EINVAL)?;
        let inode = self.inodes.get_mut(index as usize).and_then(Option::as_mut).ok_or(Errno::EBADF)?;
        if inode.group_read_leases != 0 {
            return Err(Errno::EOPNOTSUPP);
        }
        let kifs = self.kifs.as_mut().ok_or(Errno::EIO)?;
        kifs.namespace.truncate_file(inode.ino, size, now_timestamp())?;
        inode.content_gen = inode.content_gen.wrapping_add(1);
        Ok(())
    }
}
