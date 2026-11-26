//! Guest VFS watches. Each bound device description owns its own bounded queue.
//! A four-byte little-endian fd selects a readable file or directory. A read
//! returns one kind byte and the raw child name (empty for the watched object).
use alloc::{collections::VecDeque, vec::Vec};
use core::sync::atomic::{AtomicBool, Ordering};
use wasm_posix_shared::{epoll::{EPOLLIN, EPOLLRDNORM}, Errno, WasmStat};

use crate::{lock::{FileId, OfdId}, ofd::OpenFileDesc};

pub(crate) const RENAME: u8 = 1;
pub(crate) const CHANGE: u8 = 2;
const OVERFLOW: u8 = 3;
const MAX_EVENTS: usize = 32;
const MAX_WATCHES: usize = 256;

static ACTIVE: AtomicBool = AtomicBool::new(false);
static WATCHES: spin::Mutex<Vec<Watch>> = spin::Mutex::new(Vec::new());

struct Record {
    kind: u8,
    length: u8,
    name: [u8; 255],
}

struct Watch {
    owner: OfdId,
    target: FileId,
    directory: Option<u32>,
    queue: VecDeque<Record>,
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

pub(crate) fn bind(device: &OpenFileDesc, target: FileId, directory: Option<u32>) -> Result<(), Errno> {
    let mut watches = WATCHES.lock();
    if watches.iter().any(|watch| watch.owner == device.ofd_id) { return Err(Errno::EBUSY); }
    if watches.len() == MAX_WATCHES { return Err(Errno::ENOSPC); }
    watches.try_reserve(1).map_err(|_| Errno::ENOMEM)?;
    let mut queue = VecDeque::new();
    queue.try_reserve_exact(MAX_EVENTS).map_err(|_| Errno::ENOMEM)?;
    watches.push(Watch { owner: device.ofd_id, target, directory, queue });
    device.mark_vfs_watch();
    ACTIVE.store(true, Ordering::Release);
    Ok(())
}

pub(crate) fn retire(owner: OfdId) {
    let mut watches = WATCHES.lock();
    watches.retain(|watch| watch.owner != owner);
    ACTIVE.store(!watches.is_empty(), Ordering::Release);
}

pub(crate) fn readable(owner: OfdId) -> bool {
    WATCHES.lock().iter().any(|watch| watch.owner == owner && !watch.queue.is_empty())
}

pub(crate) fn read(owner: OfdId, buf: &mut [u8]) -> Result<usize, Errno> {
    let mut watches = WATCHES.lock();
    let watch = watches.iter_mut().find(|watch| watch.owner == owner).ok_or(Errno::EINVAL)?;
    let record = watch.queue.front().ok_or(Errno::EAGAIN)?;
    let length = usize::from(record.length) + 1;
    if buf.len() < length { return Err(Errno::EINVAL); }
    buf[0] = record.kind;
    buf[1..length].copy_from_slice(&record.name[..length - 1]);
    watch.queue.pop_front();
    Ok(length)
}

fn dispatch(mut publish: impl FnMut(&mut Watch)) {
    let mut ready = [OfdId(0); MAX_WATCHES];
    let mut count = 0;
    {
        let mut watches = WATCHES.lock();
        for watch in watches.iter_mut() {
            let empty = watch.queue.is_empty();
            publish(watch);
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
        let kind = if self.before != after { RENAME } else if data_changed && after.is_some() { CHANGE } else { return };
        dispatch(|watch| {
            if Some(watch.target) == self.parent { watch.append(kind, self.name); }
            if Some(watch.target) == self.before || Some(watch.target) == after { watch.append(kind, b""); }
        });
    }
}

/// Match by inode even if a writer opened a different hard link or the name
/// changed since open. Look for aliases only in directories with subscribers.
pub(crate) fn changed(target: FileId, mut children: impl FnMut(FileId, u32, &mut dyn FnMut(&[u8]))) {
    dispatch(|watch| {
        if watch.target == target { watch.append(CHANGE, b""); }
        if let Some(index) = watch.directory {
            children(watch.target, index, &mut |name| watch.append(CHANGE, name));
        }
    });
}
