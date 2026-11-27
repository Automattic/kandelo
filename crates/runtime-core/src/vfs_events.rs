//! Guest VFS watches. Each bound device description owns its own bounded queue.
//! A four-byte little-endian fd selects a readable file or directory. A read
//! returns one kind byte and the raw child name (empty for the watched object).
use alloc::{collections::VecDeque, vec::Vec};
use core::cell::Cell;
use core::mem::size_of;
use core::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use wasm_posix_shared::{epoll::{EPOLLIN, EPOLLRDNORM}, Errno, WasmStat};

use crate::{
    lock::{FileId, OfdId},
    metadata_budget::{MetadataBudget, MetadataReservation},
    ofd::OpenFileDesc,
};

pub(crate) const RENAME: u8 = 1;
pub(crate) const CHANGE: u8 = 2;
const OVERFLOW: u8 = 3;
const MAX_EVENTS: usize = 32;
const MAX_WATCHES: usize = 256;

static ACTIVE: AtomicBool = AtomicBool::new(false);
static WATCHES: spin::Mutex<WatchList> = spin::Mutex::new(WatchList {
    entries: Vec::new(),
    directories: Vec::new(),
});
static NEXT_DIRECTORY_VERSION: AtomicU64 = AtomicU64::new(1);
static DIRECTORY_INDEX_BUDGET: MetadataBudget = MetadataBudget::new(2 * 1024 * 1024);

#[derive(Default)]
pub(crate) struct DirectoryVersion(Cell<u64>);

impl DirectoryVersion {
    pub(crate) fn changed(&mut self) {
        self.0.set(0);
    }

    fn current(&self) -> u64 {
        let version = self.0.get();
        if version != 0 {
            return version;
        }
        // An inode can be retired and its slot reused. A fresh directory or
        // namespace edit must never match an older snapshot for that slot.
        let version = NEXT_DIRECTORY_VERSION.fetch_add(1, Ordering::Relaxed);
        assert_ne!(version, 0, "directory version space exhausted");
        self.0.set(version);
        version
    }
}

struct WatchList {
    entries: Vec<Watch>,
    directories: Vec<(FileId, DirectoryIndex)>,
}

#[derive(Default)]
pub(crate) struct DirectoryIndex {
    version: u64,
    entries: Option<IndexedNames>,
    positioned: Option<PositionedIndex>,
    positioned_attempted: bool,
}

struct IndexedNames {
    names: Vec<IndexedName>,
    _reservation: MetadataReservation<'static>,
}

struct IndexedName {
    inode: u32,
    order: u32,
    cookie: u64,
}

struct PositionedIndex {
    entries: Vec<(u64, usize, usize)>,
    names: Vec<u8>,
    reservation: MetadataReservation<'static>,
}

impl PositionedIndex {
    fn append(&mut self, name: &[u8], inode: u64) -> Result<(), Errno> {
        let end = self.names.len().checked_add(name.len()).ok_or(Errno::ENOMEM)?;
        let count = self.entries.len() + 1;
        if count > self.entries.capacity() || end > self.names.capacity() {
            let entries = self.entries.capacity().max(count.next_power_of_two());
            let bytes = self.names.capacity().max(end.next_power_of_two());
            let charge = |entries: usize, bytes: usize| {
                entries.checked_mul(size_of::<(u64, usize, usize)>())
                    .and_then(|index| index.checked_add(bytes)).ok_or(Errno::ENOMEM)
            };
            self.reservation.resize(charge(entries, bytes)?)?;
            self.entries.try_reserve_exact(entries - self.entries.len()).map_err(|_| Errno::ENOMEM)?;
            self.names.try_reserve_exact(bytes - self.names.len()).map_err(|_| Errno::ENOMEM)?;
            self.reservation.resize(charge(self.entries.capacity(), self.names.capacity())?)?;
        }
        self.entries.push((inode, self.names.len(), end));
        self.names.extend_from_slice(name);
        Ok(())
    }

    fn update(&mut self, name: &[u8], before: Option<FileId>, after: Option<FileId>) -> Result<(), Errno> {
        if let Some(FileId::Host { ino, .. }) = before {
            let start = self.entries.partition_point(|&(number, _, _)| number < ino);
            if let Some(offset) = self.entries[start..].iter().take_while(|&&(number, _, _)| number == ino)
                .position(|&(_, start, end)| &self.names[start..end] == name) {
                self.entries.remove(start + offset);
            }
        }
        if let Some(FileId::Host { ino, .. }) = after {
            let position = self.entries.partition_point(|&(number, start, end)| {
                (number, &self.names[start..end]) < (ino, name)
            });
            if self.entries.get(position).is_some_and(|&(number, start, end)| {
                number == ino && &self.names[start..end] == name
            }) {
                return Ok(());
            }
            self.append(name, ino)?;
            self.entries[position..].rotate_right(1);
        }
        Ok(())
    }
}

type VisitName<'a> = dyn FnMut(&[u8], u64) -> Result<(), Errno> + 'a;

impl DirectoryIndex {
    /// Index a positioned directory on first use. Namespace events keep the
    /// index current. Large directories can still stream aliases in budget.
    pub(crate) fn matching_positioned(
        &mut self,
        inode: u64,
        mut enumerate: impl FnMut(&mut VisitName<'_>) -> Result<(), Errno>,
        emit: &mut dyn FnMut(&[u8]),
    ) {
        if !self.positioned_attempted {
            self.positioned_attempted = true;
            self.positioned = (|| {
                let mut index = PositionedIndex {
                    entries: Vec::new(), names: Vec::new(),
                    reservation: DIRECTORY_INDEX_BUDGET.reserve(0).ok()?,
                };
                enumerate(&mut |name, child| index.append(name, child)).ok()?;
                index.entries.sort_unstable_by(|&(left, start, end), &(right, other_start, other_end)| {
                    (left, &index.names[start..end]).cmp(&(right, &index.names[other_start..other_end]))
                });
                Some(index)
            })();
        }
        if let Some(index) = &self.positioned {
            let start = index.entries.partition_point(|&(number, _, _)| number < inode);
            for &(_, start, end) in index.entries[start..].iter().take_while(|&&(number, _, _)| number == inode) {
                emit(&index.names[start..end]);
            }
        } else {
            let _ = enumerate(&mut |name, child| {
                if child == inode { emit(name); }
                Ok(())
            });
        }
    }

    pub(crate) fn matching_names<'a, I: Iterator<Item = (&'a [u8], u32, u64)>>(
        &mut self,
        inode: u32,
        version: &DirectoryVersion,
        count: usize,
        entries: impl Fn() -> I,
        name_for_cookie: impl Fn(u64) -> Option<&'a [u8]>,
        emit: &mut dyn FnMut(&[u8]),
    ) {
        let version = version.current();
        if self.version != version {
            self.entries = None;
            self.version = version;
            self.entries = (|| {
                let bytes = count.checked_mul(size_of::<IndexedName>())?;
                let mut reservation = DIRECTORY_INDEX_BUDGET.reserve(bytes).ok()?;
                let mut names = Vec::new();
                names.try_reserve_exact(count).ok()?;
                reservation.resize(names.capacity().checked_mul(size_of::<IndexedName>())?).ok()?;
                // Sorting by the original name order preserves delivery order
                // for an inode with multiple hard links in this directory.
                names.extend(entries().enumerate().map(|(order, (_, inode, cookie))| IndexedName {
                    inode, order: order as u32, cookie,
                }));
                names.sort_unstable_by_key(|name| (name.inode, name.order));
                Some(IndexedNames { names, _reservation: reservation })
            })();
        }
        if let Some(entries) = &self.entries {
            let start = entries.names.partition_point(|name| name.inode < inode);
            for name in entries.names[start..].iter().take_while(|name| name.inode == inode) {
                emit(name_for_cookie(name.cookie).expect("indexed directory cookie missing"));
            }
        } else {
            // Large directories or memory pressure still deliver every event.
            for (name, child, _) in entries() {
                if child == inode {
                    emit(name);
                }
            }
        }
    }
}

struct Record {
    kind: u8,
    length: u8,
    name: [u8; 255],
}

struct Watch {
    owner: OfdId,
    target: FileId,
    directory: Option<WatchedDirectory>,
    queue: VecDeque<Record>,
}

#[derive(Clone, Copy)]
pub(crate) enum WatchedDirectory {
    Resident(u32),
    Positioned,
}

impl Watch {
    fn append(&mut self, mut kind: u8, mut name: &[u8]) {
        if let Some(last) = self.queue.back() {
            if last.kind == OVERFLOW || (last.kind == kind && &last.name[..usize::from(last.length)] == name) {
                return;
            }
        }
        if self.queue.len() == MAX_EVENTS || name.len() > 255 {
            self.queue.clear();
            kind = OVERFLOW;
            name = b"";
        }
        let mut record = Record { kind, length: name.len() as u8, name: [0; 255] };
        record.name[..name.len()].copy_from_slice(name);
        self.queue.push_back(record);
    }
}

pub(crate) fn identity(stat: WasmStat) -> FileId {
    FileId::Host { dev: stat.st_dev, ino: stat.st_ino }
}

pub(crate) fn active() -> bool {
    cfg!(feature = "vfs-events") && ACTIVE.load(Ordering::Acquire)
}

pub(crate) fn bind(device: &OpenFileDesc, target: FileId, directory: Option<WatchedDirectory>) -> Result<(), Errno> {
    let mut watches = WATCHES.lock();
    if watches.entries.iter().any(|watch| watch.owner == device.ofd_id) { return Err(Errno::EBUSY); }
    if watches.entries.len() == MAX_WATCHES { return Err(Errno::ENOSPC); }
    watches.entries.try_reserve(1).map_err(|_| Errno::ENOMEM)?;
    let mut queue = VecDeque::new();
    queue.try_reserve_exact(MAX_EVENTS).map_err(|_| Errno::ENOMEM)?;
    if directory.is_some() {
        if let Err(position) = watches.directories.binary_search_by_key(&target, |(id, _)| *id) {
            watches.directories.try_reserve(1).map_err(|_| Errno::ENOMEM)?;
            watches.directories.insert(position, (target, DirectoryIndex::default()));
        }
    }
    watches.entries.push(Watch { owner: device.ofd_id, target, directory, queue });
    device.mark_vfs_watch();
    ACTIVE.store(true, Ordering::Release);
    Ok(())
}

pub(crate) fn retire(owner: OfdId) {
    let mut watches = WATCHES.lock();
    let Some(position) = watches.entries.iter().position(|watch| watch.owner == owner) else { return; };
    let watch = watches.entries.remove(position);
    if watch.directory.is_some() && !watches.entries.iter().any(|other| other.target == watch.target) {
        let position = watches.directories.binary_search_by_key(&watch.target, |(id, _)| *id)
            .expect("watched directory missing");
        watches.directories.remove(position);
    }
    ACTIVE.store(!watches.entries.is_empty(), Ordering::Release);
}

pub(crate) fn readable(owner: OfdId) -> bool {
    WATCHES.lock().entries.iter().any(|watch| watch.owner == owner && !watch.queue.is_empty())
}

pub(crate) fn read(owner: OfdId, buf: &mut [u8]) -> Result<usize, Errno> {
    let mut watches = WATCHES.lock();
    let watch = watches.entries.iter_mut().find(|watch| watch.owner == owner).ok_or(Errno::EINVAL)?;
    let record = watch.queue.front().ok_or(Errno::EAGAIN)?;
    let length = usize::from(record.length) + 1;
    if buf.len() < length { return Err(Errno::EINVAL); }
    buf[0] = record.kind;
    buf[1..length].copy_from_slice(&record.name[..length - 1]);
    watch.queue.pop_front();
    Ok(length)
}

fn dispatch(mut publish: impl FnMut(&mut Watch, &mut [(FileId, DirectoryIndex)])) {
    let mut ready = [OfdId(0); MAX_WATCHES];
    let mut count = 0;
    {
        let mut watches = WATCHES.lock();
        let WatchList { entries, directories } = &mut *watches;
        for watch in entries {
            let empty = watch.queue.is_empty();
            publish(watch, directories);
            if empty && !watch.queue.is_empty() {
                ready[count] = watch.owner;
                count += 1;
            }
        }
    }
    for &owner in &ready[..count] {
        crate::epoll::notify(crate::epoll::Source::Description(owner), EPOLLIN | EPOLLRDNORM);
    }
    if count != 0 { crate::wakeup::push_device_readable(); }
}

pub(crate) type Lookup = fn(&[u8]) -> Result<WasmStat, Errno>;

/// Compare a name before and after an already-serialized VFS transaction.
/// Replacing an inode names both objects, while a failed or no-op rename is silent.
pub(crate) struct Entry<'a> {
    lookup: Lookup,
    path: &'a [u8],
    name: &'a [u8],
    parent: Option<FileId>,
    before: Option<FileId>,
}

impl<'a> Entry<'a> {
    pub(crate) fn capture(path: &'a [u8], lookup: Lookup) -> Option<Self> {
        if !active() { return None; }
        let path = path.strip_suffix(b"/").unwrap_or(path);
        let slash = path.iter().rposition(|&byte| byte == b'/')?;
        let parent = lookup(&path[..slash.max(1)]).ok().map(identity);
        Some(Self { lookup, path, name: &path[slash+1..], parent, before: lookup(path).ok().map(identity) })
    }

    pub(crate) fn committed(self, data_changed: bool) {
        let after = (self.lookup)(self.path).ok().map(identity);
        self.committed_as(after, data_changed);
    }

    /// Publish a name whose post-mutation identity is already known.
    pub(crate) fn committed_as(self, after: Option<FileId>, data_changed: bool) {
        let kind = if self.before != after { RENAME } else if data_changed && after.is_some() { CHANGE } else { return };
        dispatch(|watch, directories| {
            if Some(watch.target) == self.parent {
                if kind == RENAME && matches!(watch.directory, Some(WatchedDirectory::Positioned)) {
                    let position = directories.binary_search_by_key(&watch.target, |(id, _)| *id)
                        .expect("watched directory missing");
                    let index = &mut directories[position].1;
                    if index.positioned.as_mut().is_some_and(|names| names.update(self.name, self.before, after).is_err()) {
                        // Names are append-only within a snapshot. Reclaim
                        // retired names by rebuilding after admission fails.
                        index.positioned = None;
                        index.positioned_attempted = false;
                    }
                }
                watch.append(kind, self.name);
            }
            if Some(watch.target) == self.before || Some(watch.target) == after { watch.append(kind, b""); }
        });
    }
}

/// Match by inode even if a writer opened a different hard link or the name
/// changed since open. Look for aliases only in directories with subscribers.
pub(crate) fn changed(
    target: FileId,
    mut children: impl FnMut(FileId, WatchedDirectory, &mut DirectoryIndex, &mut dyn FnMut(&[u8])),
) {
    dispatch(|watch, directories| {
        if watch.target == target { watch.append(CHANGE, b""); }
        if let Some(index) = watch.directory {
            let position = directories.binary_search_by_key(&watch.target, |(id, _)| *id)
                .expect("watched directory missing");
            children(watch.target, index, &mut directories[position].1, &mut |name| watch.append(CHANGE, name));
        }
    });
}
