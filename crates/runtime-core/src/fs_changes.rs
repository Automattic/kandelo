//! Bounded notifications from the authoritative filesystem, enabled on demand.
//!
//! These are hints to re-read current state, not a durable audit log. Overflow
//! invalidates each watched directory rather than silently losing a change.
use alloc::{collections::VecDeque, vec::Vec};
use core::sync::atomic::{AtomicBool, Ordering};
use wasm_posix_shared::{Errno, WasmStat};

const MAX_PREFIXES: usize = 16;
const MAX_EVENTS: usize = 256;
static ENABLED: AtomicBool = AtomicBool::new(false);
static STATE: spin::Mutex<Changes> = spin::Mutex::new(Changes::new());

struct Changes {
    prefixes: Vec<Vec<u8>>,
    events: VecDeque<(u8, Vec<u8>)>,
}

fn within(prefix: &[u8], path: &[u8]) -> bool {
    path == prefix
        || (path.starts_with(prefix) && (prefix == b"/" || path.get(prefix.len()) == Some(&b'/')))
}

impl Changes {
    const fn new() -> Self {
        Self {
            prefixes: Vec::new(),
            events: VecDeque::new(),
        }
    }
    fn watch(&mut self, prefix: &[u8], enabled: bool) -> Result<(), Errno> {
        if prefix.first() != Some(&b'/')
            || prefix.len() > 4096
            || prefix.windows(2).any(|pair| pair == b"//")
            || prefix.contains(&0)
            || (prefix.len() > 1 && prefix.ends_with(b"/"))
            || prefix
                .split(|b| *b == b'/')
                .any(|c| c == b"." || c == b"..")
        {
            return Err(Errno::EINVAL);
        }
        if enabled && !self.prefixes.iter().any(|p| p == prefix) {
            if self.prefixes.len() == MAX_PREFIXES {
                return Err(Errno::ENOSPC);
            }
            self.prefixes.push(prefix.to_vec());
        } else if !enabled {
            self.prefixes.retain(|p| p != prefix);
            self.events
                .retain(|(_, path)| self.prefixes.iter().any(|p| within(p, path)));
        }
        Ok(())
    }
    fn publish(&mut self, kind: u8, path: &[u8]) {
        if !self.prefixes.iter().any(|p| within(p, path)) {
            return;
        }
        if let Some(event) = self.events.iter_mut().find(|(_, p)| p == path) {
            event.0 = kind;
            return;
        }
        if self.events.len() == MAX_EVENTS {
            self.invalidate();
        }
        self.events.push_back((kind, path.to_vec()));
    }
    fn invalidate(&mut self) {
        self.events.clear();
        for prefix in &self.prefixes {
            self.events.push_back((1, prefix.clone()));
        }
    }
    fn drain(&mut self, out: &mut [u8]) -> Result<usize, Errno> {
        let mut used = 0;
        while let Some((kind, path)) = self.events.front() {
            let len = 5 + path.len();
            if len > out.len() - used {
                if used == 0 {
                    return Err(Errno::EOVERFLOW);
                }
                break;
            }
            out[used] = *kind;
            out[used + 1..used + 5].copy_from_slice(&(path.len() as u32).to_le_bytes());
            out[used + 5..used + len].copy_from_slice(path);
            used += len;
            self.events.pop_front();
        }
        Ok(used)
    }
    fn has_pending(&self) -> bool {
        !self.events.is_empty()
    }
}

pub fn watch(prefix: &[u8], enabled: bool) -> Result<(), Errno> {
    let mut state = STATE.lock();
    state.watch(prefix, enabled)?;
    ENABLED.store(!state.prefixes.is_empty(), Ordering::Relaxed);
    Ok(())
}

/// No allocation or mutex acquisition when nobody watches the filesystem.
pub fn publish(kind: u8, path: &[u8]) {
    if ENABLED.load(Ordering::Relaxed) {
        STATE.lock().publish(kind, path);
    }
}

/// An OFD keeps the name used to open it, while its inode can be renamed or
/// replaced at that name. Never turn a stale name into a precise close hint.
pub fn publish_close(path: &[u8], handle: i64) {
    if !ENABLED.load(Ordering::Relaxed) {
        return;
    }
    // WHY: perform metadata work only for active subscriptions. An old name
    // outside the watched directories can now name an inode moved into one;
    // checking only the old prefix would lose that final write.
    let still_names_inode = if crate::rootfs::is_rootfs_file_handle(handle) {
        close_name_status(crate::rootfs::fstat(handle), || crate::rootfs::lstat(path))
    } else if crate::tmpfs::is_tmpfs_file_handle(handle) {
        close_name_status(crate::tmpfs::fstat(handle), || crate::tmpfs::lstat(path))
    } else {
        Some(true)
    };
    // Writes to a now-unlinked inode change no directory entry. Its earlier
    // unlink already notified consumers; do not refresh unrelated tool dirs.
    let Some(still_names_inode) = still_names_inode else { return; };
    let mut state = STATE.lock();
    if still_names_inode {
        state.publish(1, path);
    } else {
        state.invalidate();
    }
}

fn close_name_status(
    open: Result<WasmStat, Errno>,
    named: impl FnOnce() -> Result<WasmStat, Errno>,
) -> Option<bool> {
    match open {
        Ok(open) if open.st_nlink == 0 => None,
        Ok(open) => Some(named().is_ok_and(|named| open.st_dev == named.st_dev && open.st_ino == named.st_ino)),
        Err(_) => Some(false),
    }
}

pub fn drain(out: &mut [u8]) -> Result<usize, Errno> {
    STATE.lock().drain(out)
}

/// Readiness only: leave every queued record for the normal bounded drain.
pub fn has_pending() -> bool {
    ENABLED.load(Ordering::Relaxed) && STATE.lock().has_pending()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn file_stat(ino: u64, nlink: u32) -> WasmStat {
        WasmStat {
            st_dev: 2, st_ino: ino, st_mode: 0, st_nlink: nlink,
            st_uid: 0, st_gid: 0, st_size: 0, st_atime_sec: 0,
            st_atime_nsec: 0, st_mtime_sec: 0, st_mtime_nsec: 0,
            st_ctime_sec: 0, st_ctime_nsec: 0, _pad: 0, st_rdev: 0,
        }
    }
    #[test]
    fn watches_components_coalesces_and_unsubscribes() {
        let mut state = Changes::new();
        state.watch(b"/etc/mcp", true).unwrap();
        state.publish(1, b"/etc/mcp-old/a");
        state.publish(1, b"/etc/mcp/a");
        state.publish(2, b"/etc/mcp/a");
        assert_eq!(state.events.len(), 1);
        let mut out = [0; 32];
        assert_eq!(state.drain(&mut out).unwrap(), 15);
        assert_eq!(out[0], 2);
        assert_eq!(&out[5..15], b"/etc/mcp/a");
        state.watch(b"/etc/mcp", false).unwrap();
        state.publish(1, b"/etc/mcp/a");
        assert!(state.events.is_empty());
    }
    #[test]
    fn readiness_survives_partial_drain_and_clears_after_unsubscribe() {
        let mut state = Changes::new();
        state.watch(b"/etc/mcp", true).unwrap();
        assert!(!state.has_pending());
        state.publish(1, b"/elsewhere/a");
        assert!(!state.has_pending());
        state.publish(1, b"/etc/mcp/a");
        state.publish(1, b"/etc/mcp/b");
        assert!(state.has_pending());
        assert_eq!(state.drain(&mut [0; 15]).unwrap(), 15);
        assert!(state.has_pending());
        assert_eq!(state.drain(&mut [0; 15]).unwrap(), 15);
        assert!(!state.has_pending());
        state.publish(1, b"/etc/mcp/c");
        state.watch(b"/etc/mcp", false).unwrap();
        assert!(!state.has_pending());
    }
    #[test]
    fn overflow_keeps_a_refresh_for_every_watched_prefix() {
        let mut state = Changes::new();
        state.watch(b"/etc/mcp", true).unwrap();
        state.watch(b"/home/maker/mcp", true).unwrap();
        for i in 0..=MAX_EVENTS {
            state.publish(1, alloc::format!("/etc/mcp/{i}").as_bytes());
        }
        assert!(state.events.iter().any(|(_, p)| p == b"/etc/mcp"));
        assert!(state.events.iter().any(|(_, p)| p == b"/home/maker/mcp"));
        assert!(state.drain(&mut [0; 1]).is_err());
        assert!(!state.events.is_empty());
    }
    #[test]
    fn rejects_ambiguous_or_unbounded_watches() {
        let mut state = Changes::new();
        for path in [
            b"relative".as_slice(),
            b"/etc/../mcp",
            b"/etc/mcp/",
            b"/a\0b",
        ] {
            assert_eq!(state.watch(path, true), Err(Errno::EINVAL));
        }
        for i in 0..MAX_PREFIXES {
            state
                .watch(alloc::format!("/{i}").as_bytes(), true)
                .unwrap();
        }
        assert_eq!(state.watch(b"/extra", true), Err(Errno::ENOSPC));
    }
    #[test]
    fn unknown_current_name_refreshes_every_watch_without_stale_file_hints() {
        let mut state = Changes::new();
        state.watch(b"/etc/mcp", true).unwrap();
        state.watch(b"/home/maker/mcp", true).unwrap();
        state.publish(2, b"/etc/mcp/old.json");
        state.invalidate();
        assert_eq!(state.events.len(), 2);
        assert!(state.events.iter().all(|(kind, path)| *kind == 1 && state.prefixes.contains(path)));
        assert!(state.events.iter().all(|(_, path)| path != b"/etc/mcp/old.json"));
    }
    #[test]
    fn closing_an_unlinked_inode_never_looks_up_its_old_name() {
        let open = file_stat(7, 0);
        assert_eq!(close_name_status(Ok(open), || panic!("unnamed inode has no path to inspect")), None);
    }
    #[test]
    fn an_existing_name_must_still_refer_to_the_same_inode() {
        let open = file_stat(7, 1);
        let named = file_stat(8, 1);
        assert_eq!(close_name_status(Ok(open), || Ok(named)), Some(false));
    }
}
