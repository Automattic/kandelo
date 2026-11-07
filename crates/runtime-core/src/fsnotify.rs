//! Kernel-private inode notification prerequisite, not an activated inotify ABI.
//!
//! Queue/watch memory and shared lifetime are real owners. No public guest
//! syscall is fabricated. The dormant descriptor follow-up owns real fd/OFD
//! and core readiness state; no public inotify route is activated. Activation still
//! requires the separately reviewed ABI55/fork/marshalling/descriptor work.
//! Existing fs_changes refresh hints remain a different contract.
use core::sync::atomic::{AtomicU32, AtomicUsize, Ordering};
use wasm_posix_shared::Errno;
use crate::{IoBuffer, IoDeque};
use crate::descriptor_backing::GlobalBackingTable;

pub(crate) const ACCESS: u32 = 0x0000_0001;
pub(crate) const CLOSE_WRITE: u32 = 0x0000_0008;
pub(crate) const CLOSE_NOWRITE: u32 = 0x0000_0010;
pub(crate) const OPEN: u32 = 0x0000_0020;
pub(crate) const MODIFY: u32 = 0x0000_0002;
pub(crate) const ATTRIB: u32 = 0x0000_0004;
pub(crate) const MOVED_FROM: u32 = 0x0000_0040;
pub(crate) const MOVED_TO: u32 = 0x0000_0080;
pub(crate) const CREATE: u32 = 0x0000_0100;
pub(crate) const DELETE: u32 = 0x0000_0200;
pub(crate) const DELETE_SELF: u32 = 0x0000_0400;
pub(crate) const MOVE_SELF: u32 = 0x0000_0800;
pub(crate) const Q_OVERFLOW: u32 = 0x0000_4000;
pub(crate) const IGNORED: u32 = 0x0000_8000;
pub(crate) const MASK_CREATE: u32 = 0x1000_0000;
pub(crate) const MASK_ADD: u32 = 0x2000_0000;
pub(crate) const ISDIR: u32 = 0x4000_0000;
pub(crate) const ONESHOT: u32 = 0x8000_0000;
// This private subset deliberately refuses events its producers do not own.
const EVENTS: u32 = MODIFY | ATTRIB | MOVED_FROM | MOVED_TO | CREATE | DELETE | DELETE_SELF | MOVE_SELF;
const OPENED_EVENTS: u32 = EVENTS | ACCESS | OPEN | CLOSE_WRITE | CLOSE_NOWRITE;
const FLAGS: u32 = MASK_CREATE | MASK_ADD | ONESHOT;
const HEADER: usize = 16;
const NAME_MAX: usize = 255;

static INSTANCES: GlobalBackingTable<State> = GlobalBackingTable::new();
static ACTIVE_INSTANCES: AtomicUsize = AtomicUsize::new(0);
static RENAME_COOKIE: AtomicU32 = AtomicU32::new(1);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct InodeId { dev: u64, ino: u64 }
impl InodeId {
    pub(crate) fn new(dev: u64, ino: u64) -> Self { Self { dev, ino } }
}

/// Admission limits for this actual private owner, not fabricated Linux procfs
/// defaults or a per-uid public quota. Per-user/public syscall admission remains separate.
pub(crate) struct Limits { pub watches: usize, pub events: usize }
struct Watch { id: InodeId, wd: i32, mask: u32 }

#[derive(Clone, Copy, PartialEq, Eq)]
struct Event {
    wd: i32,
    mask: u32,
    cookie: u32,
    name_len: usize,
    name: [u8; NAME_MAX + 1],
}
impl Event {
    fn new(wd: i32, mask: u32, cookie: u32, name: &[u8]) -> Option<Self> {
        if name.len() > NAME_MAX || name.contains(&0) { return None; }
        let mut event = Self { wd, mask, cookie, name_len: name.len(), name: [0; NAME_MAX + 1] };
        event.name[..name.len()].copy_from_slice(name);
        Some(event)
    }
    fn overflow() -> Self { Self::new(-1, Q_OVERFLOW, 0, b"").unwrap() }
    fn padded_name_len(&self) -> usize {
        if self.name_len == 0 { 0 } else { (self.name_len + 1 + HEADER - 1) & !(HEADER - 1) }
    }
    fn wire_len(&self) -> usize { HEADER + self.padded_name_len() }
    fn same_tail(&self, other: &Self) -> bool {
        // Linux inotify coalesces only the adjacent tail, compares wd/mask/name
        // (not cookie), and never merges IN_IGNORED. It is not path coalescing.
        self.mask & IGNORED == 0 && self.wd == other.wd && self.mask == other.mask
            && self.name_len == other.name_len && self.name == other.name
    }
    fn encode(&self, out: &mut [u8]) {
        let name_len = self.padded_name_len();
        out[..4].copy_from_slice(&self.wd.to_le_bytes());
        out[4..8].copy_from_slice(&self.mask.to_le_bytes());
        out[8..12].copy_from_slice(&self.cookie.to_le_bytes());
        out[12..16].copy_from_slice(&(name_len as u32).to_le_bytes());
        out[16..16 + name_len].copy_from_slice(&self.name[..name_len]);
    }
}
struct State {
    watches: IoBuffer<Watch>,
    queue: IoDeque<Event>,
    limit: Limits,
    next_wd: i32,
    overflow_queued: bool,
}
impl State {
    fn new(limit: Limits) -> Result<Self, Errno> {
        if limit.watches == 0 || limit.events == 0 || limit.watches > 4096 || limit.events > 16384 {
            return Err(Errno::EINVAL);
        }
        // Pre-admit publication storage, including one distinct overflow event.
        // A committed VFS mutation cannot fail or allocate while enqueuing.
        let watches = IoBuffer::try_with_capacity(limit.watches)?;
        let mut queue = IoDeque::new();
        queue.try_reserve(limit.events.checked_add(1).ok_or(Errno::ENOMEM)?)?;
        Ok(Self { watches, queue, limit, next_wd: 1, overflow_queued: false })
    }
    fn overflow(&mut self) {
        if !self.overflow_queued {
            self.queue.push_back(Event::overflow());
            self.overflow_queued = true;
        }
    }
    fn enqueue(&mut self, event: Event) {
        if event.mask == Q_OVERFLOW { self.overflow();return; }
        if self.queue.back().is_some_and(|tail| tail.same_tail(&event)) { return; }
        if self.queue.len() >= self.limit.events { self.overflow(); }
        else { self.queue.push_back(event); }
    }
    fn watch(&mut self, id: InodeId, mask: u32) -> Result<i32, Errno> {
        self.watch_supported(id, mask, EVENTS)
    }
    fn watch_supported(&mut self, id: InodeId, mask: u32, supported: u32) -> Result<i32, Errno> {
        if mask & supported == 0 || mask & MASK_CREATE != 0 && mask & MASK_ADD != 0 { return Err(Errno::EINVAL); }
        if mask & !(supported | FLAGS) != 0 { return Err(Errno::EOPNOTSUPP); }
        if let Some(watch) = self.watches.iter_mut().find(|watch| watch.id == id) {
            if mask & MASK_CREATE != 0 { return Err(Errno::EEXIST); }
            watch.mask = if mask & MASK_ADD != 0 { watch.mask | mask } else { mask } & (supported | ONESHOT);
            return Ok(watch.wd);
        }
        if self.watches.len() == self.limit.watches { return Err(Errno::ENOSPC); }
        let next = self.next_wd.checked_add(1).ok_or(Errno::ENOSPC)?;
        let wd = self.next_wd;
        self.watches.push(Watch { id, wd, mask: mask & (supported | ONESHOT) });
        self.next_wd = next;
        Ok(wd)
    }
    fn remove(&mut self, wd: i32) -> Result<(), Errno> {
        let index = self.watches.iter().position(|watch| watch.wd == wd).ok_or(Errno::EINVAL)?;
        self.watches.remove(index);
        self.enqueue(Event::new(wd, IGNORED, 0, b"").unwrap());
        Ok(())
    }
    fn emit(&mut self, id: InodeId, mask: u32, cookie: u32, name: &[u8]) {
        let Some(index) = self.watches.iter().position(|watch| watch.id == id && watch.mask & mask & OPENED_EVENTS != 0) else { return; };
        let wd = self.watches[index].wd;
        let oneshot = self.watches[index].mask & ONESHOT != 0;
        match Event::new(wd, mask, cookie, name) {
            Some(event) => self.enqueue(event),
            None => self.enqueue(Event::overflow()),
        }
        if oneshot { self.remove(wd).unwrap(); }
    }
    fn deleted(&mut self, id: InodeId) {
        self.emit(id, DELETE_SELF, 0, b"");
        // Retirement is unconditional; a watch not requesting DELETE_SELF
        // still receives IGNORED and cannot follow a recycled inode slot.
        if let Some(wd) = self.watches.iter().find(|watch| watch.id == id).map(|watch| watch.wd) {
            self.remove(wd).unwrap();
        }
    }
    fn read(&mut self, out: &mut [u8]) -> Result<usize, Errno> {
        if self.queue.is_empty() { return Err(Errno::EAGAIN); }
        let mut used = 0;
        while let Some(event) = self.queue.front() {
            let len = event.wire_len();
            if len > out.len() - used {
                if used == 0 { return Err(Errno::EINVAL); }
                break;
            }
            event.encode(&mut out[used..used + len]);
            let event = self.queue.pop_front().unwrap();
            if event.mask == Q_OVERFLOW { self.overflow_queued = false; }
            used += len;
        }
        Ok(used)
    }
}

/// An opaque owning Rust reference, NOT a guest fd. Clones retain the same
/// kernel-global SharedBackingTable entry; the last release destroys it.
pub(crate) struct Instance { index: usize }
impl Instance {
    pub(crate) fn new(limits: Limits) -> Result<Self, Errno> {
        let state = State::new(limits)?;
        INSTANCES.with(|table| {
            let index = table.try_alloc(state)?;
            if let Err(error) = encode_handle(index) { table.release(index);return Err(error); }
            ACTIVE_INSTANCES.fetch_add(1, Ordering::Release);
            Ok(Self { index })
        })
    }
    fn into_descriptor_handle(self) -> i64 {
        let handle = encode_handle(self.index).expect("notification handle was pre-admitted");
        core::mem::forget(self);handle
    }
    pub(crate) fn try_clone(&self) -> Result<Self, Errno> {
        INSTANCES.with(|table| { table.add_ref(self.index)?; Ok(Self { index: self.index }) })
    }
    pub(crate) fn watch_tmpfs(&self, path: &[u8], mask: u32) -> Result<i32, Errno> {
        crate::tmpfs::watch_notifications(path, self, mask)
    }
    pub(crate) fn watch_inode(&self, id: InodeId, mask: u32) -> Result<i32, Errno> {
        INSTANCES.with(|table| table.get_mut(self.index).ok_or(Errno::EBADF)?.watch(id, mask))
    }
    pub(crate) fn watch_opened_inode(&self, id: InodeId, mask: u32) -> Result<i32, Errno> {
        INSTANCES.with(|table| table.get_mut(self.index).ok_or(Errno::EBADF)?.watch_supported(id, mask, OPENED_EVENTS))
    }
    pub(crate) fn remove(&self, wd: i32) -> Result<(), Errno> {
        INSTANCES.with(|table| {
            let state = table.get_mut(self.index).ok_or(Errno::EBADF)?;
            let queued = state.queue.len();let result = state.remove(wd);
            notify_added(self.index, state, queued);result
        })
    }
    pub(crate) fn read(&self, out: &mut [u8]) -> Result<usize, Errno> {
        INSTANCES.with(|table| table.get_mut(self.index).ok_or(Errno::EBADF)?.read(out))
    }
    pub(crate) fn readable(&self) -> bool {
        INSTANCES.with(|table| table.get(self.index).is_some_and(|state| !state.queue.is_empty()))
    }
    pub(crate) fn queued_bytes(&self) -> usize {
        INSTANCES.with(|table| table.get(self.index).map_or(0, |state| state.queue.iter().map(Event::wire_len).sum()))
    }
}
impl Drop for Instance {
    fn drop(&mut self) {
        release_index(self.index);
    }
}

fn encode_handle(index: usize) -> Result<i64, Errno> {
    i64::try_from(index).ok().and_then(|index| index.checked_add(1))
        .and_then(i64::checked_neg).ok_or(Errno::EOVERFLOW)
}
fn handle_index(handle: i64) -> Result<usize, Errno> {
    if handle >= 0 { return Err(Errno::EBADF); }
    handle.checked_neg().and_then(|handle| handle.checked_sub(1))
        .and_then(|index| usize::try_from(index).ok()).ok_or(Errno::EBADF)
}
fn release_index(index: usize) -> bool {
    INSTANCES.with(|table| {
        let released = table.release(index);
        if released { ACTIVE_INSTANCES.fetch_sub(1, Ordering::Release); }
        released
    })
}
pub(crate) fn is_live_handle(handle: i64) -> bool {
    handle_index(handle).is_ok_and(|index| INSTANCES.with(|table| table.is_owned(index)))
}
pub(crate) fn retain_handle(handle: i64) -> Result<(), Errno> {
    let index = handle_index(handle)?;INSTANCES.with(|table| table.add_ref(index))
}
pub(crate) fn release_handle(handle: i64) -> bool {
    handle_index(handle).is_ok_and(release_index)
}
pub(crate) fn read_handle(handle: i64, out: &mut [u8]) -> Result<usize, Errno> {
    let index = handle_index(handle)?;
    INSTANCES.with(|table| table.get_mut(index).ok_or(Errno::EBADF)?.read(out))
}
pub(crate) fn readable_handle(handle: i64) -> bool {
    handle_index(handle).is_ok_and(|index| INSTANCES.with(|table| table.get(index).is_some_and(|state| !state.queue.is_empty())))
}
pub(crate) fn queued_handle_bytes(handle: i64) -> Result<usize, Errno> {
    let index = handle_index(handle)?;
    INSTANCES.with(|table| Ok(table.get(index).ok_or(Errno::EBADF)?.queue.iter().map(Event::wire_len).sum()))
}
/// Dormant kernel-internal admission; public inotify slots still return ENOSYS.
/// Prepared fd/OFD/path/flags admission precedes allocation of the queue owner.
pub(crate) fn open_description(proc: &mut crate::process::Process, flags: u32, limits: Limits) -> Result<i32, Errno> {
    use wasm_posix_shared::flags::{O_CLOEXEC, O_NONBLOCK, O_RDONLY};
    if flags & !(O_CLOEXEC | O_NONBLOCK) != 0 { return Err(Errno::EINVAL); }
    let fd_flags = if flags & O_CLOEXEC != 0 { wasm_posix_shared::fd_flags::FD_CLOEXEC } else { 0 };
    proc.open_descriptor(crate::ofd::FileType::FsNotify, O_RDONLY | (flags & O_NONBLOCK), b"anon_inode:inotify", fd_flags,
        |_, _| Ok(Instance::new(limits)?.into_descriptor_handle()))
}
fn description_handle(proc: &crate::process::Process, fd: i32) -> Result<i64, Errno> {
    let entry = proc.fd_table.get(fd)?;
    let ofd = proc.ofd_table.get(entry.ofd_ref.0).ok_or(Errno::EBADF)?;
    if ofd.file_type != crate::ofd::FileType::FsNotify || ofd.is_path_only() { return Err(Errno::EINVAL); }
    Ok(ofd.host_handle)
}
/// This deliberately consumes the existing private tmpfs watch subset only;
/// public pathname marshalling/permission/full-mask policy remain unimplemented.
pub(crate) fn watch_tmpfs_description(proc: &crate::process::Process, fd: i32, path: &[u8], mask: u32) -> Result<i32, Errno> {
    let handle = description_handle(proc, fd)?;retain_handle(handle)?;
    let reference = Instance { index: handle_index(handle)? };crate::tmpfs::watch_opened_notifications(path, &reference, mask)
}
pub(crate) fn remove_description_watch(proc: &crate::process::Process, fd: i32, wd: i32) -> Result<(), Errno> {
    let handle = description_handle(proc, fd)?;retain_handle(handle)?;
    let reference = Instance { index: handle_index(handle)? };reference.remove(wd)
}
fn notify_added(index: usize, state: &State, queued_before: usize) {
    if state.queue.len() > queued_before {
        crate::wait_park::with(|parks| parks.note_source_ready(crate::wait_queue::WakeSource::Backing(
            crate::wait_queue::BackingReadSource::FsNotify(encode_handle(index).expect("notification handle was pre-admitted")))));
        // Lock order is tmpfs inode -> notification table -> epoll table.
        // The allocation-free candidate marker never queries this table or
        // calls providers; delivery queries queues only after its snapshot
        // released the epoll borrow. Keep this actual backing pinned by the
        // notification-table borrow, avoiding a reusable-index wakeup window.
        crate::epoll::notify(crate::epoll::Source::Backing(crate::ofd::FileType::FsNotify,
            encode_handle(index).expect("notification handle was pre-admitted")),
            wasm_posix_shared::epoll::EPOLLIN | wasm_posix_shared::epoll::EPOLLRDNORM);
    }
}

#[cfg(test)]
pub(crate) fn test_instance_count() -> usize { ACTIVE_INSTANCES.load(Ordering::Acquire) }

pub(crate) fn rename_cookie() -> u32 {
    RENAME_COOKIE.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |cookie| Some(cookie.wrapping_add(1).max(1))).unwrap()
}
pub(crate) fn publish(id: InodeId, is_dir: bool, mask: u32, cookie: u32, name: &[u8]) {
    if ACTIVE_INSTANCES.load(Ordering::Acquire) == 0 { return; }
    // Linux omits ISDIR for MOVE_SELF/DELETE_SELF, including actual directories.
    let mask = mask | if is_dir && mask & (MOVE_SELF | DELETE_SELF) == 0 { ISDIR } else { 0 };
    INSTANCES.with(|table| { for (index, state) in table.iter_mut() {
        let queued = state.queue.len();state.emit(id, mask, cookie, name);notify_added(index, state, queued);
    } });
}
pub(crate) fn inode_deleted(id: InodeId) {
    if ACTIVE_INSTANCES.load(Ordering::Acquire) == 0 { return; }
    INSTANCES.with(|table| { for (index, state) in table.iter_mut() {
        let queued = state.queue.len();state.deleted(id);notify_added(index, state, queued);
    } });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tmpfs;
    use alloc::{vec, vec::Vec};
    fn instance(events: usize) -> Instance { Instance::new(Limits { watches: 16, events }).unwrap() }
    fn records(owner: &Instance) -> Vec<(i32, u32, u32, Vec<u8>)> {
        let mut bytes = vec![0xaa; owner.queued_bytes()];
        let size = owner.read(&mut bytes).unwrap();assert_eq!(size, bytes.len());
        let mut out = Vec::new();let mut offset = 0;
        while offset < size {
            let wd = i32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap());
            let mask = u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into().unwrap());
            let cookie = u32::from_le_bytes(bytes[offset + 8..offset + 12].try_into().unwrap());
            let len = u32::from_le_bytes(bytes[offset + 12..offset + 16].try_into().unwrap()) as usize;
            assert_eq!(len % 16, 0);let name = &bytes[offset + 16..offset + 16 + len];
            let terminator = name.iter().position(|byte| *byte == 0).unwrap_or(0);
            assert!(name[terminator..].iter().all(|byte| *byte == 0));
            out.push((wd, mask, cookie, name[..terminator].to_vec()));offset += 16 + len;
        }
        assert!(!owner.readable());assert_eq!(owner.queued_bytes(), 0);
        out
    }
    #[test]
    fn actual_tmpfs_namespace_rename_and_inode_ownership() {
        let dir = b"/tmp/notify_namespace";tmpfs::mkdir(dir, 0o755, 0, 0).unwrap();
        let owner = instance(32);let directory = owner.watch_tmpfs(dir, CREATE | DELETE | MOVED_FROM | MOVED_TO).unwrap();
        let handle = tmpfs::open(b"/tmp/notify_namespace/a", 0o102, 0o644, 0, 0).unwrap();
        let file = owner.watch_tmpfs(b"/tmp/notify_namespace/a", MODIFY | ATTRIB | MOVE_SELF | DELETE_SELF).unwrap();
        tmpfs::write(handle, 0, b"original").unwrap();tmpfs::rename(b"/tmp/notify_namespace/a", b"/tmp/notify_namespace/b").unwrap();
        tmpfs::write(handle, 0, b"renamed").unwrap();tmpfs::chmod(b"/tmp/notify_namespace/b", 0o600).unwrap();
        let events = records(&owner);
        assert_eq!(events.iter().filter(|event| event.0 == file && event.1 == MODIFY).count(), 2);
        let from = events.iter().find(|event| event.1 == MOVED_FROM).unwrap();let to = events.iter().find(|event| event.1 == MOVED_TO).unwrap();
        assert_eq!((from.0, &from.3), (directory, &b"a".to_vec()));assert_eq!((to.0, &to.3), (directory, &b"b".to_vec()));assert_ne!(from.2, 0);assert_eq!(from.2, to.2);
        assert!(events.iter().any(|event| event.0 == file && event.1 == MOVE_SELF));assert!(events.iter().any(|event| event.0 == file && event.1 == ATTRIB));
        tmpfs::unlink(b"/tmp/notify_namespace/b").unwrap();let unlinked = records(&owner);assert!(unlinked.iter().all(|event| event.1 != DELETE_SELF));
        tmpfs::release_handle(handle);assert_eq!(records(&owner), vec![(file, DELETE_SELF, 0, vec![]), (file, IGNORED, 0, vec![])]);
        let replacement = tmpfs::open(b"/tmp/notify_namespace/b", 0o102, 0o644, 0, 0).unwrap();tmpfs::write(replacement, 0, b"replacement").unwrap();
        assert!(records(&owner).iter().all(|event| event.0 != file));tmpfs::release_handle(replacement);
    }
    #[test]
    fn short_reads_are_atomic_and_shared_owner_refs_consume_one_queue() {
        let dir = b"/tmp/notify_reads";tmpfs::mkdir(dir, 0o755, 0, 0).unwrap();let owner = instance(8);let clone = owner.try_clone().unwrap();
        let wd = owner.watch_tmpfs(dir, CREATE).unwrap();let handle = tmpfs::open(b"/tmp/notify_reads/file", 0o102, 0o644, 0, 0).unwrap();
        assert!(clone.readable());assert_eq!(owner.queued_bytes(), 32);let mut short = [0xcc; 31];assert_eq!(clone.read(&mut short), Err(Errno::EINVAL));assert_eq!(short, [0xcc; 31]);
        drop(owner);assert_eq!(records(&clone), vec![(wd, CREATE, 0, b"file".to_vec())]);assert_eq!(clone.read(&mut []), Err(Errno::EAGAIN));tmpfs::release_handle(handle);
        let index = clone.index;drop(clone);assert!(!INSTANCES.with(|table| table.get(index).is_some()));
    }
    #[test]
    fn overflow_is_distinct_and_does_not_replace_earlier_events() {
        let dir = b"/tmp/notify_overflow";tmpfs::mkdir(dir, 0o755, 0, 0).unwrap();let owner = instance(2);let wd = owner.watch_tmpfs(dir, CREATE).unwrap();
        for path in [b"/tmp/notify_overflow/a", b"/tmp/notify_overflow/b", b"/tmp/notify_overflow/c", b"/tmp/notify_overflow/d"] { let handle = tmpfs::open(path, 0o102, 0o644, 0, 0).unwrap();tmpfs::release_handle(handle); }
        assert_eq!(records(&owner), vec![(wd, CREATE, 0, b"a".to_vec()), (wd, CREATE, 0, b"b".to_vec()), (-1, Q_OVERFLOW, 0, vec![])]);
        let handle = tmpfs::open(b"/tmp/notify_overflow/e", 0o102, 0o644, 0, 0).unwrap();tmpfs::release_handle(handle);assert_eq!(records(&owner), vec![(wd, CREATE, 0, b"e".to_vec())]);
    }
    #[test]
    fn watch_alias_updates_oneshot_and_ignored_are_real() {
        let handle = tmpfs::open(b"/tmp/notify_alias", 0o102, 0o644, 0, 0).unwrap();tmpfs::link(b"/tmp/notify_alias", b"/tmp/notify_alias_second").unwrap();let owner = instance(8);
        let wd = owner.watch_tmpfs(b"/tmp/notify_alias", MODIFY).unwrap();assert_eq!(owner.watch_tmpfs(b"/tmp/notify_alias_second", ATTRIB | MASK_ADD).unwrap(), wd);
        assert_eq!(owner.watch_tmpfs(b"/tmp/notify_alias", MODIFY | MASK_CREATE), Err(Errno::EEXIST));
        tmpfs::write(handle, 0, b"a").unwrap();tmpfs::write(handle, 0, b"b").unwrap();assert_eq!(records(&owner), vec![(wd, MODIFY, 0, vec![])]);
        assert_eq!(owner.watch_tmpfs(b"/tmp/notify_alias", MODIFY | ONESHOT).unwrap(), wd);tmpfs::write(handle, 0, b"c").unwrap();assert_eq!(records(&owner), vec![(wd, MODIFY, 0, vec![]), (wd, IGNORED, 0, vec![])]);
        tmpfs::write(handle, 0, b"d").unwrap();assert!(!owner.readable());assert_eq!(owner.remove(wd), Err(Errno::EINVAL));
        let replacement = owner.watch_tmpfs(b"/tmp/notify_alias", ATTRIB).unwrap();assert_ne!(replacement, wd);owner.remove(replacement).unwrap();assert_eq!(records(&owner), vec![(replacement, IGNORED, 0, vec![])]);tmpfs::release_handle(handle);
    }
    #[test]
    fn directory_self_retirement_and_admission_boundaries() {
        let dir = b"/tmp/notify_dir_retirement";tmpfs::mkdir(dir, 0o755, 0, 0).unwrap();let owner = Instance::new(Limits { watches: 1, events: 8 }).unwrap();
        let wd = owner.watch_tmpfs(dir, DELETE_SELF).unwrap();assert_eq!(owner.watch_tmpfs(b"/tmp", CREATE), Err(Errno::ENOSPC));
        assert_eq!(owner.watch_tmpfs(dir, 0), Err(Errno::EINVAL));assert_eq!(owner.watch_tmpfs(dir, MODIFY | 1), Err(Errno::EOPNOTSUPP));
        tmpfs::rmdir(dir).unwrap();assert_eq!(records(&owner), vec![(wd, DELETE_SELF, 0, vec![]), (wd, IGNORED, 0, vec![])]);
        assert_eq!(owner.watch_tmpfs(dir, MODIFY), Err(Errno::ENOENT));
    }
}
