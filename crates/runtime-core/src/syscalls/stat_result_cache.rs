//! Positive stat results for checked, literal paths on the live KIFS mount.
use super::{Process, S_IFMT, S_IFREG, WasmStat};
use crate::{IoBuffer, rootfs::StatStamp};
use spin::Mutex;

const ENTRIES: usize = 512;
const WAYS: usize = 4;
use wasm_posix_shared::stat_cache_wire::PATH_BYTES;
const GROUPS: usize = 16;

#[derive(Clone, Copy, Eq, PartialEq)]
struct Credentials {
    uid: u32,
    gid: u32,
    groups: [u32; GROUPS],
    count: usize,
}

impl Credentials {
    fn read(proc: &Process) -> Option<Self> {
        let supplementary = proc.supplementary_groups();
        let mut groups = [0; GROUPS];
        groups
            .get_mut(..supplementary.len())?
            .copy_from_slice(supplementary);
        Some(Self {
            uid: proc.effective_uid(),
            gid: proc.effective_gid(),
            groups,
            count: supplementary.len(),
        })
    }
}

#[derive(Clone, Copy)]
pub(super) struct Request {
    path: [u8; PATH_BYTES],
    len: usize,
    index: usize,
    follow: bool,
    credentials: Credentials,
}

impl Request {
    pub(super) fn new(proc: &Process, name: &[u8], follow: bool) -> Option<Self> {
        if !crate::rootfs::supports_stat_certification() || name.is_empty() {
            return None;
        }
        let mut path = [0; PATH_BYTES];
        let len = if name.starts_with(b"/") {
            path.get_mut(..name.len())?.copy_from_slice(name);
            name.len()
        } else {
            let base = &proc.cwd[..];
            if !base.starts_with(b"/") {
                return None;
            }
            let prefix = if base == b"/" {
                1
            } else {
                base.len().checked_add(1)?
            };
            let full = prefix.checked_add(name.len())?;
            let destination = path.get_mut(..full)?;
            destination[..base.len()].copy_from_slice(base);
            destination[prefix - 1] = b'/';
            destination[prefix..].copy_from_slice(name);
            full
        };
        if !path[1..len]
            .split(|&byte| byte == b'/')
            .all(|part| !matches!(part, b"" | b"." | b"..") && !part.contains(&0))
        {
            return None;
        }
        let mut hash = if follow { 0x811c9dc5u32 } else { 0xbf051273u32 };
        for &byte in &path[..len] {
            hash = (hash ^ u32::from(byte)).wrapping_mul(0x01000193);
        }
        let index = ((hash ^ (hash >> 16)) as usize & (ENTRIES / WAYS - 1)) * WAYS;
        Some(Self {
            path,
            len,
            index,
            follow,
            credentials: Credentials::read(proc)?,
        })
    }

    fn path(&self) -> &[u8] {
        &self.path[..self.len]
    }

    fn matches(&self, entry: &Entry) -> bool {
        entry.follow == self.follow && &entry.path[..entry.len] == self.path()
    }

    pub(super) fn lookup(&self) -> Option<WasmStat> {
        let cached = {
            let mut cache = RESULTS.lock();
            if cache.credentials != Some(self.credentials) {
                return None;
            }
            cache.tick = cache.tick.saturating_add(1);
            let tick = cache.tick;
            let set = cache.entries.get_mut(self.index..self.index + WAYS)?;
            let found = set.iter_mut().flatten().find(|entry| self.matches(entry))?;
            found.recent = tick;
            *found
        };
        if crate::rootfs::stat_stamp(cached.value.st_ino) != Some(cached.stamp)
            || !super::ordinary_stat_result_path(self.path())
        {
            return None;
        }
        Some(cached.value)
    }

    pub(super) fn remember(&self, resolved: &[u8], value: WasmStat) -> bool {
        if value.st_dev != crate::rootfs::ROOTFS_DEV
            || value.st_mode & S_IFMT != S_IFREG
            || resolved != self.path()
            || !super::ordinary_stat_result_path(resolved)
        {
            return false;
        }
        let Some(stamp) = crate::rootfs::stat_stamp(value.st_ino) else {
            return false;
        };
        let mut cache = RESULTS.lock();
        if cache.entries.is_empty() {
            let Ok(entries) = IoBuffer::try_filled(ENTRIES, None) else {
                return false;
            };
            cache.entries = entries;
        }
        if cache.credentials != Some(self.credentials) {
            cache.entries.fill(None);
            cache.credentials = Some(self.credentials);
        }
        cache.tick = cache.tick.saturating_add(1);
        let recent = cache.tick;
        let set = &mut cache.entries[self.index..self.index + WAYS];
        let index = set
            .iter()
            .position(|entry| entry.as_ref().is_some_and(|e| self.matches(e)))
            .unwrap_or_else(|| {
                set.iter()
                    .enumerate()
                    .min_by_key(|(_, entry)| entry.map_or(0, |entry| entry.recent))
                    .expect("fixed nonempty set")
                    .0
            });
        set[index] = Some(Entry {
            path: self.path,
            len: self.len,
            value,
            stamp,
            follow: self.follow,
            recent,
        });
        true
    }
}

#[derive(Clone, Copy)]
struct Entry {
    path: [u8; PATH_BYTES],
    len: usize,
    value: WasmStat,
    stamp: StatStamp,
    follow: bool,
    recent: u64,
}

struct Cache {
    credentials: Option<Credentials>,
    entries: IoBuffer<Option<Entry>>,
    tick: u64,
}

impl Cache {
    const fn new() -> Self {
        Self {
            credentials: None,
            entries: IoBuffer::new(),
            tick: 0,
        }
    }
}

static RESULTS: Mutex<Cache> = Mutex::new(Cache::new());

pub(super) fn reset() {
    *RESULTS.lock() = Cache::new();
}
