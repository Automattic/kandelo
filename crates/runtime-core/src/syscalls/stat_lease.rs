//! One bounded certificate from an ordinary, checked stat record.
use crate::{
    rootfs::StatStamp,
    process::{Process, ProcessState},
};
use spin::Mutex;
use wasm_posix_shared::{Errno, Syscall, WasmStat, stat_cache_wire::*};

const GROUPS: usize = 16;

#[derive(Clone, Copy, PartialEq, Eq)]
struct Scope {
    fifo_route: u64,
    socket_route: u64,
    pid: u32,
    exec: u64,
    uid: u32,
    gid: u32,
    cwd: [u8; PATH_BYTES],
    cwd_len: usize,
    groups: [u32; GROUPS],
    group_count: usize,
}

impl Scope {
    fn for_process(proc: &Process) -> Option<Self> {
        if proc.state != ProcessState::Running || !proc.threads.is_empty() {
            return None;
        }
        let mut cwd = [0; PATH_BYTES];
        cwd.get_mut(..proc.cwd.len())?.copy_from_slice(&proc.cwd);
        let mut groups = [0; GROUPS];
        let supplementary = proc.supplementary_groups();
        groups
            .get_mut(..supplementary.len())?
            .copy_from_slice(supplementary);
        // All process and namespace authority is read under the serialized kernel.
        let fifo_route = unsafe { crate::fifo::global_fifo_table() }.pathname_generation();
        let socket_route =
            unsafe { crate::unix_socket::global_unix_socket_registry() }.pathname_generation();
        if fifo_route == u64::MAX || socket_route == u64::MAX {
            return None;
        }
        Some(Self {
            fifo_route,
            socket_route,
            pid: proc.pid,
            exec: proc.exec_generation,
            uid: proc.effective_uid(),
            gid: proc.effective_gid(),
            cwd,
            cwd_len: proc.cwd.len(),
            groups,
            group_count: supplementary.len(),
        })
    }
}

struct Evidence {
    scope: Scope,
    syscall: u32,
    flags: u32,
    literal: [u8; PATH_BYTES],
    len: usize,
    stat: WasmStat,
    stamp: StatStamp,
}

struct State {
    armed: bool,
    last: Option<Evidence>,
    scope: Option<Scope>,
    serial: u64,
}

static STATE: Mutex<State> = Mutex::new(State {
    armed: false,
    last: None,
    scope: None,
    serial: 0,
});

pub struct Capture;

pub fn begin(syscall: u32, deliver: u32) -> Option<Capture> {
    if deliver == 0
        || !matches!(
            Syscall::from_u32(syscall),
            Some(Syscall::Stat | Syscall::Lstat | Syscall::Fstatat)
        )
        || !crate::rootfs::supports_stat_certification()
    {
        return None;
    }
    let mut state = STATE.lock();
    state.armed = true;
    state.last = None;
    Some(Capture)
}

impl Drop for Capture {
    fn drop(&mut self) {
        STATE.lock().armed = false;
    }
}

pub(super) fn record(proc: &Process, literal: &[u8], syscall: u32, flags: u32, stat: WasmStat) {
    let mut state = STATE.lock();
    if !state.armed {
        return;
    }
    state.last = None;
    let mut name = [0; PATH_BYTES];
    let Some(dst) = name.get_mut(..literal.len()) else {
        return;
    };
    let Some(scope) = Scope::for_process(proc) else {
        return;
    };
    let Some(stamp) = crate::rootfs::stat_stamp(stat.st_ino) else {
        return;
    };
    dst.copy_from_slice(literal);
    state.last = Some(Evidence {
        scope,
        syscall,
        flags,
        literal: name,
        len: literal.len(),
        stat,
        stamp,
    });
}

fn u32_at(bytes: &mut [u8], offset: usize, value: u32) {
    bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

fn u64_at(bytes: &mut [u8], offset: usize, value: u64) {
    bytes[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
}

pub fn take(proc: &Process, tid: u32, syscall: u32, bytes: &mut [u8]) -> Result<bool, Errno> {
    if bytes.len() != BYTES {
        return Err(Errno::EINVAL);
    }
    let mut state = STATE.lock();
    let Some(result) = state.last.take() else {
        return Ok(false);
    };
    if state.armed
        || !proc.is_main_thread(tid)
        || proc.next_deliverable_signal(tid).is_some()
        || result.syscall != syscall
        || Scope::for_process(proc) != Some(result.scope)
    {
        return Ok(false);
    }
    if state.scope != Some(result.scope) {
        let Some(serial) = state.serial.checked_add(1) else {
            return Ok(false);
        };
        state.serial = serial;
        state.scope = Some(result.scope);
    }
    bytes.fill(0);
    let Some(index) = crate::rootfs::write_stat_lease_buckets(
        result.stat.st_ino,
        result.stamp,
        &mut bytes[GENERATIONS_OFFSET..],
    ) else {
        return Ok(false);
    };
    crate::process_wire::write_stat(&mut bytes[STAT_OFFSET..GENERATIONS_OFFSET], &result.stat)?;
    bytes[PATH_OFFSET..PATH_OFFSET + result.len].copy_from_slice(&result.literal[..result.len]);
    u32_at(bytes, LENGTH_OFFSET, BYTES as u32);
    u32_at(bytes, PID_OFFSET, proc.pid);
    u32_at(bytes, TID_OFFSET, tid);
    u64_at(bytes, SCOPE_OFFSET, state.serial);
    u64_at(bytes, ROUTE_OFFSET, result.stamp.route);
    u64_at(bytes, PATHNAME_GENERATION_OFFSET, result.stamp.pathname);
    u64_at(bytes, INODE_GENERATION_OFFSET, result.stamp.inode);
    u32_at(bytes, BUCKET_OFFSET, index as u32);
    u32_at(bytes, SYSCALL_OFFSET, syscall);
    u32_at(bytes, FLAGS_OFFSET, result.flags);
    u32_at(bytes, PATH_LENGTH_OFFSET, result.len as u32);
    u32_at(bytes, MAGIC_OFFSET, MAGIC);
    Ok(true)
}

#[cfg(test)]
mod tests {
    use crate::{fifo::FifoTable, unix_socket::UnixSocketRegistry};

    #[test]
    fn fifo_pathname_generation_tracks_namespace_publication() {
        let mut names = FifoTable::new();
        assert_eq!(names.pathname_generation(), 0);
        assert!(names.register(b"/old/fifo".to_vec(), 1));
        assert!(!names.register(b"/old/fifo".to_vec(), 2));
        assert_eq!(names.pathname_generation(), 1);
        names.rename_path(b"/old", b"/live");
        assert_eq!(names.pathname_generation(), 2);
        assert_eq!(names.remove_under(b"/missing").len(), 0);
        assert_eq!(names.pathname_generation(), 2);
        assert_eq!(names.remove_under(b"/live"), [1]);
        assert_eq!(names.pathname_generation(), 3);
    }

    #[test]
    fn socket_pathname_generation_includes_tombstones_and_ignores_abstract_endpoints() {
        let mut names = UnixSocketRegistry::new();
        assert!(names.register(b"\0abstract".to_vec(), 5, 1));
        assert!(names.remove_owner_exact(5, 1));
        assert_eq!(names.pathname_generation(), 0);
        assert!(names.register(b"/old/socket".to_vec(), 5, 2));
        assert!(names.remove_owner_exact(5, 2));
        assert!(names.contains(b"/old/socket"));
        assert_eq!(names.pathname_generation(), 1);
        assert!(names.rename_path(b"/old", b"/live"));
        assert_eq!(names.pathname_generation(), 2);
        assert!(names.unregister(b"/live/socket"));
        assert_eq!(names.pathname_generation(), 3);
    }
}
